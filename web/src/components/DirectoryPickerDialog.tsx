import {
  ArrowUp,
  Copy,
  Folder,
  FolderPlus,
  House,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "../store";
import type { DirectoryList } from "../types";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "../useConnectionClient";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";

export function DirectoryPickerDialog({
  open,
  initialPath,
  title = "Choose Folder",
  selectLabel = "Use This Folder",
  onSelect,
  onClose,
}: {
  open: boolean;
  initialPath?: string;
  title?: string;
  selectLabel?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [listing, setListing] = useState<DirectoryList | null>(null);
  const [pathDraft, setPathDraft] = useState(initialPath ?? "");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const requestKeyRef = useRef("");
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  const load = useCallback(
    async (path: string, hidden: boolean) => {
      const key = connectionClientScopeKey(connectionClient, path, hidden);
      requestKeyRef.current = key;
      setLoading(true);
      setError(null);
      try {
        const result = (await connectionClient.call("directory.list", {
          path,
          show_hidden: hidden,
        })) as DirectoryList;
        if (requestKeyRef.current !== key) return;
        setListing(result);
        setPathDraft(result.path);
      } catch (e) {
        if (requestKeyRef.current !== key) return;
        setError((e as Error).message);
      } finally {
        if (requestKeyRef.current === key) setLoading(false);
      }
    },
    [connectionClient],
  );

  useEffect(() => {
    if (!open) return;
    setNewFolderName("");
    setCreatingFolder(false);
    void load(initialPath?.trim() ?? "", showHidden);
    const cancelFocus = focusDialogElement(pathInputRef.current, {
      select: true,
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
    // Reloading on `showHidden` is handled by its own toggle handler.
    // biome-ignore lint/correctness/useExhaustiveDependencies: open-only reset
  }, [open, initialPath, load]);

  if (!open) return null;

  const currentPath = listing?.path ?? "";

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    void load(currentPath || pathDraft, next);
  };

  const copyPath = async () => {
    const value = currentPath || pathDraft;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      store.notify({
        kind: "success",
        message: "Path copied",
        detail: value,
        autoDismissMs: 5000,
      });
    } catch (e) {
      store.notify({
        kind: "error",
        message: "Failed to copy path",
        detail: (e as Error).message,
      });
    }
  };

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const parent = currentPath || pathDraft;
    try {
      const result = (await connectionClient.call("directory.create", {
        path: parent,
        name,
      })) as { path: string };
      setNewFolderName("");
      setCreatingFolder(false);
      await load(result.path, showHidden);
    } catch (e) {
      store.notify({
        kind: "error",
        message: "Failed to create folder",
        detail: (e as Error).message,
      });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal directory-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="directory-picker-path">
          <input
            ref={pathInputRef}
            value={pathDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="/path/to/folder"
            aria-label="Folder path"
            onChange={(e) => setPathDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void load(pathDraft.trim(), showHidden);
            }}
          />
          <button
            type="button"
            className="ghost icon-button"
            title="Copy path"
            aria-label="Copy path"
            onClick={() => void copyPath()}
          >
            <Copy size={14} />
          </button>
        </div>

        <div className="directory-picker-toolbar">
          <button
            type="button"
            className="ghost icon-button"
            title="Parent folder"
            aria-label="Parent folder"
            disabled={!listing?.parent}
            onClick={() => {
              if (listing?.parent) void load(listing.parent, showHidden);
            }}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="ghost icon-button"
            title="Home folder"
            aria-label="Home folder"
            onClick={() => void load(listing?.home ?? "~", showHidden)}
          >
            <House size={14} />
          </button>
          <button
            type="button"
            className="ghost icon-button"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void load(currentPath || pathDraft, showHidden)}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="ghost icon-button"
            title="New folder"
            aria-label="New folder"
            onClick={() => {
              setCreatingFolder(true);
              window.setTimeout(() => newFolderRef.current?.focus(), 0);
            }}
          >
            <FolderPlus size={14} />
          </button>
          <label className="directory-picker-hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={toggleHidden}
            />
            <span>Hidden</span>
          </label>
        </div>

        {creatingFolder && (
          <div className="directory-picker-new">
            <input
              ref={newFolderRef}
              value={newFolderName}
              placeholder="New folder name"
              aria-label="New folder name"
              onChange={(e) => setNewFolderName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitNewFolder();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCreatingFolder(false);
                  setNewFolderName("");
                }
              }}
            />
            <button type="button" onClick={() => void submitNewFolder()}>
              Create
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setCreatingFolder(false);
                setNewFolderName("");
              }}
            >
              Cancel
            </button>
          </div>
        )}

        <div className="directory-picker-list" role="listbox">
          {error && (
            <div className="directory-picker-state is-error">{error}</div>
          )}
          {!error && loading && (
            <div className="directory-picker-state muted">Loading…</div>
          )}
          {!error && !loading && listing?.entries.length === 0 && (
            <div className="directory-picker-state muted">No subfolders</div>
          )}
          {!error &&
            !loading &&
            listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="directory-picker-item"
                onDoubleClick={() => void load(entry.path, showHidden)}
                onClick={() => void load(entry.path, showHidden)}
              >
                <Folder size={14} />
                <span>{entry.name}</span>
              </button>
            ))}
          {listing?.truncated && (
            <div className="directory-picker-state muted">
              Listing truncated
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!currentPath && !pathDraft.trim()}
            onClick={() => {
              onSelect(currentPath || pathDraft.trim());
              onClose();
            }}
          >
            {selectLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
