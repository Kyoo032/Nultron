type Listener = (event: Event) => void;

class MiniNode {
  ownerDocument: MiniDocument;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  nodeType = 0;
  nodeName = "";
  nodeValue: string | null = null;

  constructor(ownerDocument: MiniDocument) {
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): MiniNode | null {
    if (!this.parentNode) {
      return null;
    }
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] ?? null) : null;
  }

  get previousSibling(): MiniNode | null {
    if (!this.parentNode) {
      return null;
    }
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index > 0 ? (siblings[index - 1] ?? null) : null;
  }

  appendChild<T extends MiniNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore<T extends MiniNode>(node: T, before: MiniNode | null): T {
    if (!before) {
      return this.appendChild(node);
    }
    const index = this.childNodes.indexOf(before);
    if (index < 0) {
      throw new Error("insertBefore reference node is not a child");
    }
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild<T extends MiniNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index < 0) {
      throw new Error("removeChild node is not a child");
    }
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChild<T extends MiniNode>(node: T, old: MiniNode): MiniNode {
    this.insertBefore(node, old);
    this.removeChild(old);
    return old;
  }

  contains(node: MiniNode | null): boolean {
    let current = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) {
      this.removeChild(child);
    }
    if (value) {
      this.appendChild(this.ownerDocument.createTextNode(value));
    }
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

class MiniText extends MiniNode {
  constructor(ownerDocument: MiniDocument, value: string, nodeType = 3) {
    super(ownerDocument);
    this.nodeType = nodeType;
    this.nodeName = nodeType === 3 ? "#text" : "#comment";
    this.nodeValue = value;
  }

  override get textContent(): string {
    return this.nodeValue ?? "";
  }

  override set textContent(value: string) {
    this.nodeValue = value;
  }
}

class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly localName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>();
  style: Record<string, string> = {};
  value = "";
  checked = false;
  disabled = false;

  constructor(ownerDocument: MiniDocument, tagName: string) {
    super(ownerDocument);
    this.nodeType = 1;
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(value: string) {
    this.attributes.set("class", value);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  scrollIntoView(): void {}

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

class MiniDocumentFragment extends MiniNode {
  constructor(ownerDocument: MiniDocument) {
    super(ownerDocument);
    this.nodeType = 11;
    this.nodeName = "#document-fragment";
  }
}

class MiniDocument extends MiniNode {
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null = null;
  defaultView: unknown = null;
  visibilityState = "visible";
  hidden = false;

  constructor() {
    super(null as unknown as MiniDocument);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.nodeName = "#document";
    this.documentElement = new MiniElement(this, "html");
    this.body = new MiniElement(this, "body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): MiniElement {
    return new MiniElement(this, tagName);
  }

  createTextNode(value: string): MiniText {
    return new MiniText(this, String(value));
  }

  createComment(value: string): MiniText {
    return new MiniText(this, String(value), 8);
  }

  createDocumentFragment(): MiniDocumentFragment {
    return new MiniDocumentFragment(this);
  }
}

export type MiniDom = {
  document: MiniDocument;
  window: Window & typeof globalThis;
  restore: () => void;
};

function restoreGlobal(name: string, previous: PropertyDescriptor | undefined): void {
  if (previous) {
    Object.defineProperty(globalThis, name, previous);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

export function installMiniDom(): MiniDom {
  const document = new MiniDocument();
  const listeners = new Map<string, Set<Listener>>();
  class HTMLIFrameElement {}
  const windowListeners = {
    addEventListener(type: string, listener: Listener) {
      const entries = listeners.get(type) ?? new Set<Listener>();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) {
        listener(event);
      }
      return true;
    },
  };
  const miniWindow = {
    document,
    window: null as unknown,
    self: null as unknown,
    top: null as unknown,
    HTMLIFrameElement,
    HTMLElement: MiniElement,
    Element: MiniElement,
    Node: MiniNode,
    Event: globalThis.Event,
    location: { href: "http://localhost/", origin: "http://localhost" },
    addEventListener: windowListeners.addEventListener,
    removeEventListener: windowListeners.removeEventListener,
    dispatchEvent: windowListeners.dispatchEvent,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: Parameters<typeof clearInterval>[0]) => clearInterval(id),
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16),
    cancelAnimationFrame: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
  };
  miniWindow.window = miniWindow;
  miniWindow.self = miniWindow;
  miniWindow.top = miniWindow;
  document.defaultView = miniWindow;

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "window", { value: miniWindow, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });

  return {
    document,
    window: miniWindow as unknown as Window & typeof globalThis,
    restore: () => {
      restoreGlobal("window", previousWindow);
      restoreGlobal("document", previousDocument);
      restoreGlobal("IS_REACT_ACT_ENVIRONMENT", previousAct);
    },
  };
}
