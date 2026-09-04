// Moved from the retired src/mobile/installMobileTextEncodingFix.ts. Logic is
// unchanged; only encapsulated so a root React hook can mount it once. The
// legacy window-scoped install flag became a module-level boolean so the gate's
// private-window-globals budget can drop to zero. The legacy permanent
// MutationObserver was intentionally retired: on the mobile table workspace it
// can rescan large React subtrees on every render and saturate the browser.

const suspiciousPattern = /(?:Ãƒ.|Ã‚.|Ã¢[\u0080-\u00BF]|ï¿½)/;
const suspiciousChars = /[ÃƒÃ‚Ã¢ï¿½]/g;
const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const attributeNames = [
  "placeholder",
  "title",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "alt",
] as const;
const decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;

function looksBroken(value: unknown): value is string {
  return typeof value === "string" && suspiciousPattern.test(value);
}

function suspiciousScore(value: string) {
  return (value.match(suspiciousChars) || []).length;
}

function decodeLatin1Utf8(value: string) {
  try {
    if (decoder) {
      const bytes = Uint8Array.from(Array.from(value), (char) => char.charCodeAt(0) & 0xff);
      return decoder.decode(bytes);
    }
    return decodeURIComponent(escape(value));
  } catch {
    return value;
  }
}

function isBetterDecoded(decoded: string, original: string) {
  if (!decoded || decoded === original) return false;
  if (decoded.includes("\uFFFD") && !original.includes("\uFFFD")) return false;
  if (controlPattern.test(decoded)) return false;
  return suspiciousScore(decoded) < suspiciousScore(original);
}

function repairString(value: string) {
  if (!looksBroken(value)) return value;

  let current = value;
  for (let index = 0; index < 4; index += 1) {
    const decoded = decodeLatin1Utf8(current);
    if (!isBetterDecoded(decoded, current)) break;
    current = decoded;
    if (!looksBroken(current)) break;
  }
  return current;
}

function shouldSkipElement(element: Element | null) {
  if (!(element instanceof Element)) return true;
  const tagName = element.tagName;
  return (
    tagName === "SCRIPT" || tagName === "STYLE" || tagName === "NOSCRIPT" || tagName === "TEXTAREA"
  );
}

function repairAttributes(element: Element) {
  if (shouldSkipElement(element)) return;

  for (const attributeName of attributeNames) {
    if (!element.hasAttribute(attributeName)) continue;
    const currentValue = element.getAttribute(attributeName);
    if (!looksBroken(currentValue)) continue;
    const repairedValue = repairString(currentValue);
    if (repairedValue !== currentValue) {
      element.setAttribute(attributeName, repairedValue);
    }
  }
}

function repairTextNode(node: Text) {
  const currentValue = node.nodeValue;
  if (!looksBroken(currentValue)) return;
  const repairedValue = repairString(currentValue);
  if (repairedValue !== currentValue) {
    node.nodeValue = repairedValue;
  }
}

function repairTree(rootNode: Node | Document) {
  if (rootNode instanceof Text) {
    repairTextNode(rootNode);
    return;
  }

  if (!(rootNode instanceof Element) && !(rootNode instanceof Document)) return;

  if (rootNode instanceof Element) {
    if (shouldSkipElement(rootNode)) return;
    repairAttributes(rootNode);
  }

  const walker = document.createTreeWalker(
    rootNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node instanceof Element) {
          return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
        if (node instanceof Text) {
          return shouldSkipElement(node.parentElement)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    }
  );

  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof Element) {
      repairAttributes(currentNode);
    } else if (currentNode instanceof Text) {
      repairTextNode(currentNode);
    }
    currentNode = walker.nextNode();
  }
}

let textEncodingFixInstalled = false;

export function installDocumentTextEncodingFix() {
  if (textEncodingFixInstalled) return;
  textEncodingFixInstalled = true;

  const pendingNodes = new Set<Node | Document>();
  let flushScheduled = false;

  const flushQueue = () => {
    flushScheduled = false;
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const node of nodes) {
      repairTree(node);
    }
  };

  const scheduleRepair = (node: Node | Document | null) => {
    if (!node) return;
    pendingNodes.add(node);
    if (flushScheduled) return;
    flushScheduled = true;
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(flushQueue);
    } else {
      window.setTimeout(flushQueue, 0);
    }
  };

  const startObserver = () => {
    scheduleRepair(document.documentElement);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
}
