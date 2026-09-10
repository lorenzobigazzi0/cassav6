type Props = {
  open: boolean;
  actionLabel: string;
  ownerLabel: string;
  reason: string;
  busy: boolean;
  error: string;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function CrossOperatorInterventionDialog(props: Props) {
  if (!props.open) return null;
  const valid = props.reason.trim().length >= 3;
  return (
    <div className="mobile-analytics-fiscal-void-backdrop" role="presentation" onPointerDown={() => !props.busy && props.onClose()}>
      <section className="mobile-analytics-fiscal-void-modal cross-operator-intervention-modal" role="alertdialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()}>
        <header><div><strong>Intervento su altro operatore</strong><span>{props.ownerLabel}</span></div></header>
        <p>Stai per eseguire {props.actionLabel.toLowerCase()} su un pagamento attribuito a un altro operatore. L&apos;operazione sarà registrata e notificata.</p>
        <label><span>MOTIVO OBBLIGATORIO</span><textarea autoFocus value={props.reason} maxLength={240} onChange={(event) => props.onReasonChange(event.target.value)} placeholder="Indica il motivo dell'intervento amministrativo" /></label>
        {props.error ? <div className="mobile-analytics-detail-error">{props.error}</div> : null}
        <footer>
          <button type="button" className="smallbtn fiscal-void-cancel" disabled={props.busy} onClick={props.onClose}>ANNULLA</button>
          <button type="button" className="smallbtn fiscal-void-confirm" disabled={props.busy || !valid} onClick={props.onConfirm}>{props.busy ? "ESECUZIONE..." : "CONFERMA"}</button>
        </footer>
      </section>
    </div>
  );
}
