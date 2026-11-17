"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Heart,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { qrSvgPath, qrSvgViewBox } from "@/lib/client/qr-svg";
import {
  DONATION_ADDRESS,
  DONATION_NETWORKS,
  DONATION_QR_PAYLOADS,
  donationExplorerUrl,
} from "@/lib/client/donation";

/** One-coin glyph, drawn inline so the dialog needs no icon font or network. */
function CryptoGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v9M14.6 9.3c-.6-.8-1.5-1.2-2.6-1.2-1.4 0-2.4.8-2.4 2 0 2.7 5.2 1.4 5.2 4.1 0 1.2-1.1 2-2.6 2-1.2 0-2.2-.5-2.8-1.4" />
    </svg>
  );
}

interface DonateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Renders `text` as a scannable QR code.
 *
 * The generator is imported lazily (it is only needed while this dialog is
 * open) and the modules are painted into an inline SVG — crisp on retina
 * screens, printable, with no canvas, no network call and no third-party
 * image service ever seeing the address.
 */
function DonationQrCode({ text, label }: { text: string; label: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [moduleCount, setModuleCount] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPath(null);
    setFailed(false);
    import("qrcode-generator")
      .then((mod) => {
        if (cancelled) return;
        const qrcode = (mod.default ?? mod) as typeof import("qrcode-generator");
        const qr = qrcode(0, "M");
        qr.addData(text, "Byte");
        qr.make();
        // "M" (≈15% recovery) keeps the code readable from a phone screen while
        // staying small enough for a wallet app to scan quickly. Each horizontal
        // run of dark modules becomes one rect, so the whole 33×33 code is a few
        // hundred characters instead of a thousand elements.
        const built = qrSvgPath(qr);
        setModuleCount(built.moduleCount);
        setPath(built.path);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (failed) {
    return (
      <div className="flex h-[168px] w-[168px] items-center justify-center rounded-xl border border-white/10 bg-white/5 p-3 text-center text-[11px] text-slate-400">
        QR unavailable offline — copy the address instead.
      </div>
    );
  }

  if (!path) {
    return (
      <div className="flex h-[168px] w-[168px] items-center justify-center rounded-xl border border-white/10 bg-white/[0.03]">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <svg
      role="img"
      aria-label={`QR code for address ${label}`}
      viewBox={qrSvgViewBox(moduleCount)}
      className="h-[168px] w-[168px] rounded-xl bg-white p-2 shadow-lg shadow-black/40"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#0b0e14" />
    </svg>
  );
}

/**
 * "Donate crypto" dialog: the public tip-jar address, a QR code the wallet app
 * on the other phone can scan, one-tap copy, and a block-explorer link.
 */
export function DonateModal({ isOpen, onClose }: DonateModalProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [qrMode, setQrMode] =
    useState<(typeof DONATION_QR_PAYLOADS)[number]["id"]>("address");

  useEffect(() => {
    if (!isOpen) return;
    setCopied(null);
    setQrMode("address");
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  const payload = useMemo(
    () => DONATION_QR_PAYLOADS.find((option) => option.id === qrMode) ?? DONATION_QR_PAYLOADS[0],
    [qrMode]
  );

  if (!isOpen) return null;

  const copy = (id: string, value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopied(id);
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1800);
    });
  };

  return (
    <div className="modal-safe-area fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="donate-modal-title"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131b] shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Heart className="h-4 w-4 shrink-0 text-[#ff6b57]" />
            <div className="min-w-0">
              <h2 id="donate-modal-title" className="text-base font-semibold text-white">
                Donate crypto
              </h2>
              <p className="text-[11px] text-slate-400">
                Support Sushi&apos;s development — thank you
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close donation dialog"
            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/8 bg-[#0b0e14] p-4 sm:flex-row sm:items-start">
            <DonationQrCode
              text={payload.value}
              label={payload.id === "ethereum" ? `ethereum: URI for ${DONATION_ADDRESS}` : DONATION_ADDRESS}
            />
            <div className="min-w-0 flex-1 space-y-2 text-center sm:text-left">
              <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-white sm:justify-start">
                <CryptoGlyph className="h-4 w-4 text-[#ff6b57]" />
                Scan with any wallet
              </div>
              <p className="text-[11px] leading-relaxed text-slate-400">
                MetaMask, Trust Wallet, Rainbow, Coinbase Wallet, Phantom (EVM) and
                every other wallet can read this code.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-start">
                {DONATION_QR_PAYLOADS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setQrMode(option.id)}
                    className={`rounded-lg border px-2 py-0.5 text-[10px] font-medium transition ${
                      qrMode === option.id
                        ? "border-[#ff6b57]/50 bg-[#ff6b57]/15 text-[#ff9587]"
                        : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/8 bg-[#121722] p-3.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-300">
                EVM address
              </span>
              <span className="text-[10px] text-slate-500">
                One address, many chains
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#090b10] p-2">
              <code className="font-mono-code min-w-0 flex-1 select-all break-all text-[11px] leading-relaxed text-slate-100">
                {DONATION_ADDRESS}
              </code>
              <button
                type="button"
                onClick={() => copy("address", DONATION_ADDRESS)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/10"
                title="Copy the donation address"
              >
                {copied === "address" ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copied === "address" ? "Copied" : "Copy"}
              </button>
            </div>
            <ul className="mt-2 grid grid-cols-1 gap-1 text-[10px] text-slate-400 sm:grid-cols-2">
              {DONATION_NETWORKS.map((network) => (
                <li key={network} className="flex items-center gap-1.5">
                  <span className="h-1 w-1 shrink-0 rounded-full bg-emerald-400/80" />
                  {network}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-amber-200/80">
              Send only crypto on these EVM chains. Assets sent on other networks
              (Bitcoin, Solana, Tron, …) cannot be recovered.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3 text-[11px] text-emerald-100/90">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              Verify the address on the block explorer before sending. Sushi never
              asks for a seed phrase or private key — nobody from this project will
              ever request one.
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/8 bg-[#0b0e14] px-4 py-3 sm:px-6">
          <a
            href={donationExplorerUrl()}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200"
          >
            View on Etherscan
            <ExternalLink className="h-3 w-3" />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-[#ff6b57] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#ff7f6e]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
