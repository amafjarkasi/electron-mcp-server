import { EventEmitter } from "events";

export type ProcessEvent =
  | {
      type: "process_started" | "process_attached" | "process_stopped" | "process_crashed";
      processId: string;
      detail?: string;
    }
  | {
      type: "console";
      processId: string;
      targetId: string;
      level: string;
      text: string;
    }
  | {
      type: "targets_changed";
      processId: string;
      targetCount: number;
    };

class ProcessEventBus extends EventEmitter {
  emitEvent(event: ProcessEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: ProcessEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const processEvents = new ProcessEventBus();
