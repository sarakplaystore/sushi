import crypto from "node:crypto";
import http from "node:http";

/**
 * Minimal Firestore REST transaction fixture. The production Google SDK still
 * serializes/decodes every request; this fixture only replaces the remote
 * service. It models snapshot reads, atomic commits, preconditions and ABORTED
 * retries, not the complete Firestore API or the Google-managed emulator.
 */
type Fields = Record<string, unknown>;
interface StoredDocument { fields: Fields; version: number; }
interface Tx { snapshot: Map<string, StoredDocument>; reads: Set<string>; }

export class MockFirestoreRest {
  readonly documents = new Map<string, StoredDocument>();
  private readonly transactions = new Map<string, Tx>();
  private sequence = 0;
  private txSequence = 0;
  private barrier: { remaining: number; wait: Promise<void>; release: () => void } | undefined;
  offline = false;
  failAfterNextCommit = false;
  abortedCommits = 0;
  readonly server = http.createServer((req, res) => { void this.handle(req, res); });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Firestore fixture failed to start");
    return `127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  holdNextCommits(count: number): void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.barrier = { remaining: count, wait, release };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader("content-type", "application/json");
    const reply = (status: number, body: unknown) => res.writeHead(status).end(JSON.stringify(body));
    if (this.offline) {
      reply(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "fixture credential must not leak" } });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>;
    const url = req.url || "";
    const now = new Date().toISOString();
    if (url.includes("documents:batchGet")) {
      let id: string = body.transaction;
      let tx: Tx | undefined;
      if (body.newTransaction) {
        id = Buffer.from(`mock-${++this.txSequence}`).toString("base64");
        tx = { snapshot: new Map(this.documents), reads: new Set() };
        this.transactions.set(id, tx);
      } else {
        tx = this.transactions.get(id);
      }
      if (!tx) { reply(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown transaction" } }); return; }
      const docs = (body.documents as string[]).map((name, index) => {
        tx!.reads.add(name);
        const found = tx!.snapshot.get(name);
        return {
          ...(found ? { found: { name, fields: found.fields, createTime: now, updateTime: now } } : { missing: name }),
          readTime: now,
          ...(body.newTransaction && index === 0 ? { transaction: id } : {}),
        };
      });
      reply(200, docs);
      return;
    }
    if (url.includes("documents:commit")) {
      const tx = this.transactions.get(body.transaction);
      if (!tx) { reply(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown transaction" } }); return; }
      const barrier = this.barrier;
      if (barrier) {
        if (--barrier.remaining === 0) { this.barrier = undefined; barrier.release(); }
        await barrier.wait;
      }
      const changed = [...tx.reads].some((name) => tx.snapshot.get(name)?.version !== this.documents.get(name)?.version);
      const writes = (body.writes || []) as Array<Record<string, any>>;
      const badPrecondition = writes.some((write) => {
        const name = write.update?.name || write.delete;
        const expected = write.currentDocument?.exists;
        return expected !== undefined && this.documents.has(name) !== expected;
      });
      if (changed || badPrecondition) {
        this.abortedCommits++;
        this.transactions.delete(body.transaction);
        reply(409, { error: { code: 409, status: "ABORTED", message: "Transaction conflicted" } });
        return;
      }
      for (const write of writes) {
        if (write.update) this.documents.set(write.update.name, { fields: write.update.fields || {}, version: ++this.sequence });
        else if (write.delete) { this.documents.delete(write.delete); this.sequence++; }
        else throw new Error("Unsupported Firestore fixture write");
      }
      this.transactions.delete(body.transaction);
      if (this.failAfterNextCommit) {
        this.failAfterNextCommit = false;
        // The write happened but its response was lost. A caller must not claim
        // either success or that the previous data is still authoritative.
        reply(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "response lost" } });
        return;
      }
      reply(200, { writeResults: writes.map(() => ({ updateTime: now })), commitTime: now });
      return;
    }
    if (url.includes("documents:rollback")) {
      this.transactions.delete(body.transaction);
      reply(200, {});
      return;
    }
    reply(404, { error: { code: 404, status: "NOT_FOUND", message: "Unsupported fixture endpoint" } });
  }

  rawChunks(): string {
    return [...this.documents.values()].map(({ fields }) => {
      const data = fields.data as { bytesValue?: string } | undefined;
      return data?.bytesValue ? Buffer.from(data.bytesValue, "base64").toString("utf8") : "";
    }).join("\n");
  }

  corruptOnePart(prefix: "auth" | "vault", namespace: string): () => void {
    const root = crypto.createHash("sha256").update(namespace, "utf8").digest("hex");
    const entry = [...this.documents.entries()].find(([name]) => name.includes(`/sushi_state_v1/${root}/parts/${prefix}-`));
    if (!entry) throw new Error(`No ${prefix} chunk exists`);
    const [name, previous] = entry;
    this.documents.set(name, { fields: { data: { bytesValue: Buffer.from("corrupt").toString("base64") } }, version: ++this.sequence });
    return () => { this.documents.set(name, { fields: previous.fields, version: ++this.sequence }); };
  }
}
