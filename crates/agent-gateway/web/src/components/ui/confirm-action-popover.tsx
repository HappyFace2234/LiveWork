import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { AlertTriangle } from "../icons";
import { Button } from "./button";

export function ConfirmActionPopover(props: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const { title, description, confirmLabel, onConfirm, children } = props;
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    }

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [show]);

  function handleOpen() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      // Popover is ~160px tall; flip upward if not enough space below
      setFlipUp(window.innerHeight - rect.bottom < 170);
    }
    setShow(true);
  }

  return (
    <div className="relative" ref={ref}>
      {children(handleOpen)}
      {show ? (
        <div
          className={`settings-confirm-popover absolute right-0 z-50 w-64 animate-in fade-in duration-150 ${
            flipUp
              ? "bottom-full mb-1.5 slide-in-from-bottom-1"
              : "top-full mt-1.5 slide-in-from-top-1"
          }`}
        >
          <div className="rounded-xl border border-border bg-popover p-3 shadow-lg">
            <div className="flex items-start gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{title}</p>
                <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {description}
                </div>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setShow(false)}
              >
                {t("settings.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => {
                  setShow(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ConfirmDeletePopover(props: {
  name: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const { t } = useLocale();

  return (
    <ConfirmActionPopover
      title={t("settings.deleteConfirm")}
      description={
        <>
          {t("settings.deleteConfirmYes")}{" "}
          <span className="font-medium text-foreground">{props.name}</span>？
          {t("settings.deleteConfirmDesc")}
        </>
      }
      confirmLabel={t("settings.delete")}
      onConfirm={props.onConfirm}
    >
      {props.children}
    </ConfirmActionPopover>
  );
}
