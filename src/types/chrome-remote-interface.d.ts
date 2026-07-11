declare module "chrome-remote-interface" {
  interface CDPOptions {
    host?: string;
    port?: number;
    target?: string | object;
    local?: boolean;
    protocol?: object;
    secure?: boolean;
    useHostName?: boolean;
    alterPath?: (path: string) => string;
  }

  interface CDPClient {
    send(method: string, params?: object): Promise<unknown>;
    on(event: string, callback: (params: unknown) => void): void;
    removeListener(event: string, callback: (params: unknown) => void): void;
    close(): Promise<void> | void;
  }

  namespace CDP {
    type Client = CDPClient;
    function List(options?: Omit<CDPOptions, "target">): Promise<unknown[]>;
    function New(
      options?: Omit<CDPOptions, "target">
    ): Promise<{ webSocketDebuggerUrl: string }>;
    function Activate(options?: CDPOptions): Promise<void>;
    function Close(options?: CDPOptions): Promise<void>;
    function Version(options?: Omit<CDPOptions, "target">): Promise<unknown>;
    function Protocol(options?: Omit<CDPOptions, "target">): Promise<unknown>;
  }

  function CDP(options?: CDPOptions): Promise<CDP.Client>;

  export = CDP;
}
