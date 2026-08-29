import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { luckyWorkspaceName } from "../luckyName";
import { store } from "../store";
import { CloseButton } from "./CloseButton";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog";
import { focusDialogElement } from "./dialogFocus";

export function CreateWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);

  const pickerOpenRef = useRef(false);

  onCloseRef.current = onClose;
  pickerOpenRef.current = pickerOpen;

  useEffect(() => {
    if (!open) return;
    setLabel(luckyWorkspaceName());
    setCwd("");
    setPickerOpen(false);
    const cancelFocus = focusDialogElement(labelRef.current, { select: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The folder picker owns Escape while it is open.
      if (pickerOpenRef.current) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelFocus();
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    store.createWorkspace(label.trim() || undefined, cwd.trim() || undefined);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create workspace"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Create Workspace</h2>
          <CloseButton onClick={onClose} />
        </div>

        <label className="form-field">
          <span>Name</span>
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="Optional"
          />
        </label>

        <label className="form-field">
          <span>CWD</span>
          <div className="form-field-row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.currentTarget.value)}
              placeholder="Optional path"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button
              type="button"
              className="ghost icon-button"
              title="Browse folders"
              aria-label="Browse folders"
              onClick={() => setPickerOpen(true)}
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </label>

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Create</button>
        </div>
      </form>
      {pickerOpen && (
        <DirectoryPickerDialog
          open={pickerOpen}
          initialPath={cwd.trim()}
          title="Workspace Folder"
          selectLabel="Use This Folder"
          onSelect={(path) => setCwd(path)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
