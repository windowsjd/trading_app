type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

type SocketListener = (event: MessageEvent) => void;
type StatusListener = (status: SocketStatus) => void;

export class SocketClient {
  private ws: WebSocket | null = null;
  private messageListeners = new Set<SocketListener>();
  private statusListeners = new Set<StatusListener>();

  connect(url: string) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.emitStatus('connecting');

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.emitStatus('open');
    };

    this.ws.onmessage = (event) => {
      this.messageListeners.forEach((listener) => listener(event));
    };

    this.ws.onerror = () => {
      this.emitStatus('error');
    };

    this.ws.onclose = () => {
      this.emitStatus('closed');
      this.ws = null;
    };
  }

  send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  onMessage(listener: SocketListener) {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatus(status: SocketStatus) {
    this.statusListeners.forEach((listener) => listener(status));
  }
}