type TableOccupyConfirmButtonProps = {
  busy: boolean;
  onConfirm: () => void;
};

export function TableOccupyConfirmButton({ busy, onConfirm }: TableOccupyConfirmButtonProps) {
  return (
    <button type="button" className="occupy-confirm" onClick={onConfirm} disabled={busy}>
      CONFERMA OCCUPAZIONE
    </button>
  );
}
