import { useCallback, useEffect, useRef, useState } from "react";

const AUTO_SCROLL_LOCK_THRESHOLD_PX = 2;
const SCROLL_OVERFLOW_THRESHOLD = 4;
const USER_SCROLL_INTENT_WINDOW_MS = 500;
const BOTTOM_LOCK_DURATION_MS = 700;

function resolveViewport(root: HTMLDivElement | null) {
  return root?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
}

function getViewportBottomGap(viewport: HTMLDivElement) {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

function isViewportAtLatest(viewport: HTMLDivElement) {
  return getViewportBottomGap(viewport) <= AUTO_SCROLL_LOCK_THRESHOLD_PX;
}

function hasViewportOverflow(viewport: HTMLDivElement) {
  return viewport.scrollHeight - viewport.clientHeight > SCROLL_OVERFLOW_THRESHOLD;
}

function shouldShowJumpToBottom(viewport: HTMLDivElement) {
  const bottomGap = getViewportBottomGap(viewport);
  return hasViewportOverflow(viewport) && bottomGap > AUTO_SCROLL_LOCK_THRESHOLD_PX;
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isHistoryScrollKey(event: KeyboardEvent) {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

export function useGatewayScrollAffordance() {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const showJumpToBottomRef = useRef(false);
  const scrollStateRafIdRef = useRef<number | null>(null);
  const autoScrollRafIdRef = useRef<number | null>(null);
  const userScrollIntentUntilRef = useRef(0);
  const bottomLockUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const [scrollAreaElement, setScrollAreaElement] = useState<HTMLDivElement | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const applyShowJumpToBottom = useCallback((nextValue: boolean) => {
    if (showJumpToBottomRef.current === nextValue) {
      return;
    }
    showJumpToBottomRef.current = nextValue;
    setShowJumpToBottom(nextValue);
  }, []);

  const setScrollAreaRef = useCallback((node: HTMLDivElement | null) => {
    scrollAreaRef.current = node;
    setScrollAreaElement(node);
  }, []);

  const refreshScrollState = useCallback(() => {
    const viewport = resolveViewport(scrollAreaRef.current);
    applyShowJumpToBottom(viewport ? shouldShowJumpToBottom(viewport) : false);
  }, [applyShowJumpToBottom]);

  const scheduleScrollStateRefresh = useCallback(() => {
    if (scrollStateRafIdRef.current !== null) {
      return;
    }
    scrollStateRafIdRef.current = requestAnimationFrame(() => {
      scrollStateRafIdRef.current = null;
      refreshScrollState();
    });
  }, [refreshScrollState]);

  const clearAutoScroll = useCallback(() => {
    if (autoScrollRafIdRef.current !== null) {
      cancelAnimationFrame(autoScrollRafIdRef.current);
      autoScrollRafIdRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);

  const hasRecentUserScrollIntent = useCallback(
    () => Date.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const hasActiveBottomLock = useCallback(() => Date.now() <= bottomLockUntilRef.current, []);

  const attachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = true;
  }, []);

  const detachAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    bottomLockUntilRef.current = 0;
    clearAutoScroll();
  }, [clearAutoScroll]);

  const syncAutoScroll = useCallback(
    (options?: { force?: boolean }) => {
      if (options?.force !== true && !shouldAutoScrollRef.current && !hasActiveBottomLock()) {
        return false;
      }

      const viewport = viewportRef.current ?? resolveViewport(scrollAreaRef.current);
      if (!viewport) {
        return false;
      }

      const bottomScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (viewport.scrollTop !== bottomScrollTop) {
        viewport.scrollTop = bottomScrollTop;
      }
      attachAutoScroll();
      applyShowJumpToBottom(shouldShowJumpToBottom(viewport));
      return true;
    },
    [applyShowJumpToBottom, attachAutoScroll, hasActiveBottomLock],
  );

  const requestAutoScroll = useCallback(() => {
    if (autoScrollRafIdRef.current !== null) {
      return;
    }
    autoScrollRafIdRef.current = requestAnimationFrame(() => {
      autoScrollRafIdRef.current = null;
      syncAutoScroll();
    });
  }, [syncAutoScroll]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      attachAutoScroll();
      const viewport = resolveViewport(scrollAreaRef.current);
      if (!viewport) {
        return;
      }
      const bottomScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTo({ top: bottomScrollTop, behavior });
      requestAnimationFrame(() => {
        applyShowJumpToBottom(shouldShowJumpToBottom(viewport));
      });
    },
    [applyShowJumpToBottom, attachAutoScroll],
  );

  const jumpToBottom = useCallback(() => {
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  const jumpToBottomNow = useCallback(() => {
    scrollToBottom("auto");
  }, [scrollToBottom]);

  const isAtBottom = useCallback(() => {
    const viewport = resolveViewport(scrollAreaRef.current);
    return viewport ? isViewportAtLatest(viewport) : false;
  }, []);

  const stickToBottom = useCallback(() => {
    bottomLockUntilRef.current = Date.now() + BOTTOM_LOCK_DURATION_MS;
    attachAutoScroll();
    syncAutoScroll({ force: true });
    requestAutoScroll();
  }, [attachAutoScroll, requestAutoScroll, syncAutoScroll]);

  const preserveScrollPosition = useCallback(
    (callback: () => void, options?: { stickToBottom?: boolean }) => {
      const previousViewport = viewportRef.current ?? resolveViewport(scrollAreaRef.current);
      const previousBottomGap = previousViewport ? getViewportBottomGap(previousViewport) : 0;
      const shouldStickToBottom =
        options?.stickToBottom ?? (previousViewport ? isViewportAtLatest(previousViewport) : false);

      const restoreViewportScroll = () => {
        const viewport =
          previousViewport?.isConnected === true
            ? previousViewport
            : (viewportRef.current ?? resolveViewport(scrollAreaRef.current));
        if (!viewport) {
          return;
        }

        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const nextScrollTop = shouldStickToBottom
          ? maxScrollTop
          : Math.max(
              0,
              Math.min(
                maxScrollTop,
                viewport.scrollHeight - viewport.clientHeight - previousBottomGap,
              ),
            );
        viewport.scrollTop = nextScrollTop;
        applyShowJumpToBottom(shouldShowJumpToBottom(viewport));
      };

      try {
        callback();
      } finally {
        restoreViewportScroll();
        requestAnimationFrame(() => {
          restoreViewportScroll();
          if (shouldStickToBottom) {
            requestAnimationFrame(restoreViewportScroll);
          }
        });
      }
    },
    [applyShowJumpToBottom],
  );

  useEffect(() => {
    if (!scrollAreaElement) {
      applyShowJumpToBottom(false);
      viewportRef.current = null;
      return;
    }

    let cleanup: (() => void) | null = null;
    let rafId: number | null = null;

    const attachViewportListeners = () => {
      const viewport = resolveViewport(scrollAreaElement);
      if (!viewport) {
        rafId = requestAnimationFrame(attachViewportListeners);
        return;
      }

      viewportRef.current = viewport;

      const syncScrollState = () => {
        if (isViewportAtLatest(viewport)) {
          attachAutoScroll();
        } else if (hasRecentUserScrollIntent()) {
          detachAutoScroll();
        }
        applyShowJumpToBottom(shouldShowJumpToBottom(viewport));
      };

      const handleScrollStateChange = () => {
        scheduleScrollStateRefresh();
        syncScrollState();
      };

      const handleWheel = (event: WheelEvent) => {
        markUserScrollIntent();
        if (event.deltaY < 0 && hasViewportOverflow(viewport)) {
          detachAutoScroll();
        }
      };

      const handleTouchStart = (event: TouchEvent) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
        markUserScrollIntent();
      };

      const handleTouchMove = (event: TouchEvent) => {
        const nextY = event.touches[0]?.clientY ?? null;
        const previousY = touchYRef.current;
        markUserScrollIntent();
        if (
          hasViewportOverflow(viewport) &&
          (previousY === null ||
            nextY === null ||
            nextY > previousY + 1 ||
            !isViewportAtLatest(viewport))
        ) {
          detachAutoScroll();
        }
        touchYRef.current = nextY;
      };

      const handlePointerDown = () => {
        markUserScrollIntent();
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (!isHistoryScrollKey(event)) {
          return;
        }
        if (!hasViewportOverflow(viewport)) {
          return;
        }
        markUserScrollIntent();
        detachAutoScroll();
      };

      const handleContentResize = () => {
        if (syncAutoScroll()) {
          return;
        }
        scheduleScrollStateRefresh();
        syncScrollState();
      };

      refreshScrollState();
      viewport.addEventListener("scroll", handleScrollStateChange, { passive: true });
      viewport.addEventListener("wheel", handleWheel, { passive: true });
      viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
      viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
      viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });
      window.addEventListener("keydown", handleKeyDown, { capture: true });

      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              handleContentResize();
            });
      resizeObserver?.observe(viewport);

      const content = viewport.firstElementChild;
      if (content instanceof Element) {
        resizeObserver?.observe(content);
      }

      cleanup = () => {
        viewport.removeEventListener("scroll", handleScrollStateChange);
        viewport.removeEventListener("wheel", handleWheel);
        viewport.removeEventListener("touchstart", handleTouchStart);
        viewport.removeEventListener("touchmove", handleTouchMove);
        viewport.removeEventListener("pointerdown", handlePointerDown);
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
        resizeObserver?.disconnect();
        if (viewportRef.current === viewport) {
          viewportRef.current = null;
        }
      };
    };

    attachViewportListeners();

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (scrollStateRafIdRef.current !== null) {
        cancelAnimationFrame(scrollStateRafIdRef.current);
        scrollStateRafIdRef.current = null;
      }
      clearAutoScroll();
      cleanup?.();
    };
  }, [
    applyShowJumpToBottom,
    attachAutoScroll,
    clearAutoScroll,
    detachAutoScroll,
    hasRecentUserScrollIntent,
    markUserScrollIntent,
    refreshScrollState,
    requestAutoScroll,
    scheduleScrollStateRefresh,
    scrollAreaElement,
    syncAutoScroll,
  ]);

  return {
    scrollAreaRef: setScrollAreaRef,
    showJumpToBottom,
    jumpToBottom,
    jumpToBottomNow,
    stickToBottom,
    isAtBottom,
    requestAutoScroll,
    syncAutoScroll,
    refreshScrollState,
    preserveScrollPosition,
  };
}
