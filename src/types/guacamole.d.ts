declare module "guacamole-common-js" {
  export class Status {
    code: number;
    message?: string;
    constructor(code: number, message?: string);
    static Code: Record<string, number>;
  }

  export class Tunnel {
    state: number;
    uuid: string | null;
    receiveTimeout: number;
    unstableThreshold: number;
    onerror: ((status: Status) => void) | null;
    onstatechange: ((state: number) => void) | null;
    oninstruction: ((opcode: string, parameters: string[]) => void) | null;
    connect(data?: string): void;
    disconnect(): void;
    sendMessage(...elements: unknown[]): void;
    isConnected(): boolean;
    static State: {
      CONNECTING: number;
      OPEN: number;
      CLOSED: number;
      UNSTABLE: number;
    };
  }

  export class WebSocketTunnel extends Tunnel {
    constructor(tunnelURL: string);
  }

  export class Display {
    getElement(): HTMLElement;
    getWidth(): number;
    getHeight(): number;
    getScale(): number;
    scale(scale: number): void;
    showCursor(shown: boolean): void;
    flatten(): HTMLCanvasElement;
    onresize: ((width: number, height: number) => void) | null;
  }

  export interface MouseState {
    x: number;
    y: number;
    left: boolean;
    middle: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
  }

  export class Mouse {
    constructor(element: HTMLElement);
    onmousedown: ((state: MouseState) => void) | null;
    onmouseup: ((state: MouseState) => void) | null;
    onmousemove: ((state: MouseState) => void) | null;
    onmouseout: (() => void) | null;
  }

  export class Keyboard {
    constructor(element?: HTMLElement | Document | Window);
    onkeydown: ((keysym: number) => boolean | void) | null;
    onkeyup: ((keysym: number) => void) | null;
    reset(): void;
  }

  export class InputStream {
    onblob: ((data: string) => void) | null;
    onend: (() => void) | null;
    sendAck(message: string, code: number): void;
  }

  export class OutputStream {
    index: number;
    onack: ((status: Status) => void) | null;
  }

  export class StringReader {
    constructor(stream: InputStream);
    ontext: ((text: string) => void) | null;
    onend: (() => void) | null;
  }

  export class StringWriter {
    constructor(stream: OutputStream);
    sendText(text: string): void;
    sendEnd(): void;
  }

  export class GuacamoleObject {
    index: number;
    onbody: ((stream: InputStream, mimetype: string, name: string) => void) | null;
    createOutputStream(mimetype: string, name: string): OutputStream;
    requestInputStream(name: string, bodyCallback?: (stream: InputStream) => void): void;
  }

  export class BlobWriter {
    constructor(stream: OutputStream);
    onprogress: ((blob: Blob, offset: number) => void) | null;
    oncomplete: ((blob: Blob) => void) | null;
    onerror: ((blob: Blob, offset: number, error: unknown) => void) | null;
    onack: ((status: Status) => void) | null;
    sendBlob(blob: Blob): void;
  }

  export const AudioContextFactory: {
    singleton: AudioContext | null;
    getAudioContext(): AudioContext | null;
  };

  export class Client {
    constructor(tunnel: Tunnel);
    getDisplay(): Display;
    connect(data?: string): void;
    disconnect(): void;
    sendSize(width: number, height: number): void;
    sendKeyEvent(pressed: 0 | 1, keysym: number): void;
    sendMouseState(mouseState: MouseState, applyDisplayScale?: boolean): void;
    createClipboardStream(mimetype: string, name?: string): OutputStream;
    onerror: ((status: Status) => void) | null;
    onstatechange: ((state: number) => void) | null;
    onclipboard: ((stream: InputStream, mimetype: string) => void) | null;
    onfilesystem: ((object: GuacamoleObject, name: string) => void) | null;
    onname: ((name: string) => void) | null;
  }

  const GuacamoleDefault: {
    Status: typeof Status;
    Tunnel: typeof Tunnel;
    WebSocketTunnel: typeof WebSocketTunnel;
    Display: typeof Display;
    Mouse: typeof Mouse;
    Keyboard: typeof Keyboard;
    InputStream: typeof InputStream;
    OutputStream: typeof OutputStream;
    StringReader: typeof StringReader;
    StringWriter: typeof StringWriter;
    Client: typeof Client;
    GuacamoleObject: typeof GuacamoleObject;
    BlobWriter: typeof BlobWriter;
    AudioContextFactory: typeof AudioContextFactory;
  };

  export default GuacamoleDefault;
}
