(function () {
  if (window.__mobileTextEncodingFixInstalled) {
    return;
  }
  window.__mobileTextEncodingFixInstalled = true;

  const SUSPICIOUS_PATTERN = /(?:Ã.|Â.|â[\u0080-\u00BF]|�)/;
  const SUSPICIOUS_CHARS = /[ÃÂâ�]/g;
  const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
  const ATTRIBUTE_NAMES = [
    "placeholder",
    "title",
    "aria-label",
    "aria-description",
    "aria-placeholder",
    "alt",
  ];
  const decoder =
    typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;
  const pendingNodes = new Set();
  let flushScheduled = false;

  function looksBroken(value) {
    return typeof value === "string" && SUSPICIOUS_PATTERN.test(value);
  }

  function suspiciousScore(value) {
    return (String(value).match(SUSPICIOUS_CHARS) || []).length;
  }

  function decodeLatin1Utf8(value) {
    try {
      if (decoder) {
        const bytes = Uint8Array.from(Array.from(value), function (char) {
          return char.charCodeAt(0) & 0xff;
        });
        return decoder.decode(bytes);
      }
      return decodeURIComponent(escape(value));
    } catch {
      return value;
    }
  }

  function isBetterDecoded(decoded, original) {
    if (!decoded || decoded === original) {
      return false;
    }
    if (decoded.includes("\uFFFD") && !original.includes("\uFFFD")) {
      return false;
    }
    if (CONTROL_PATTERN.test(decoded)) {
      return false;
    }
    return suspiciousScore(decoded) < suspiciousScore(original);
  }

  function repairString(value) {
    if (!looksBroken(value)) {
      return value;
    }

    let current = value;
    for (let index = 0; index < 4; index += 1) {
      const decoded = decodeLatin1Utf8(current);
      if (!isBetterDecoded(decoded, current)) {
        break;
      }
      current = decoded;
      if (!looksBroken(current)) {
        break;
      }
    }
    return current;
  }

  function shouldSkipElement(element) {
    if (!(element instanceof Element)) {
      return true;
    }
    const tagName = element.tagName;
    return (
      tagName === "SCRIPT" ||
      tagName === "STYLE" ||
      tagName === "NOSCRIPT" ||
      tagName === "TEXTAREA"
    );
  }

  function repairAttributes(element) {
    if (!(element instanceof Element) || shouldSkipElement(element)) {
      return;
    }

    for (const attributeName of ATTRIBUTE_NAMES) {
      if (!element.hasAttribute(attributeName)) {
        continue;
      }
      const currentValue = element.getAttribute(attributeName);
      if (!looksBroken(currentValue)) {
        continue;
      }
      const repairedValue = repairString(currentValue);
      if (repairedValue !== currentValue) {
        element.setAttribute(attributeName, repairedValue);
      }
    }
  }

  function repairTextNode(node) {
    if (!(node instanceof Text)) {
      return;
    }
    const currentValue = node.nodeValue;
    if (!looksBroken(currentValue)) {
      return;
    }
    const repairedValue = repairString(currentValue);
    if (repairedValue !== currentValue) {
      node.nodeValue = repairedValue;
    }
  }

  function repairTree(rootNode) {
    if (!rootNode) {
      return;
    }

    if (rootNode instanceof Text) {
      repairTextNode(rootNode);
      return;
    }

    if (!(rootNode instanceof Element) && !(rootNode instanceof Document)) {
      return;
    }

    if (rootNode instanceof Element) {
      if (shouldSkipElement(rootNode)) {
        return;
      }
      repairAttributes(rootNode);
    }

    const walker = document.createTreeWalker(
      rootNode,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node instanceof Element) {
            return shouldSkipElement(node)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
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

  function flushQueue() {
    flushScheduled = false;
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const node of nodes) {
      repairTree(node);
    }
  }

  function scheduleRepair(node) {
    if (!node) {
      return;
    }
    pendingNodes.add(node);
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    const schedule =
      typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : window.setTimeout;
    schedule(flushQueue);
  }

  function startObserver() {
    scheduleRepair(document.documentElement);

    const observer = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            scheduleRepair(node);
          }
          continue;
        }
        if (mutation.type === "characterData") {
          scheduleRepair(mutation.target);
          continue;
        }
        if (mutation.type === "attributes") {
          scheduleRepair(mutation.target);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTE_NAMES,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();
