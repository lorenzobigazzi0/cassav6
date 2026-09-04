import hourglassIconSrc from "../../../../assets/icons/hourglass.png";

/** Da quanto il tavolo e' occupato, a fianco del nome: clessidra, valore, unita'. */
export function TableArrivalPill({ label }: { label: string }) {
  return (
    <span className="table-detail-arrival-time">
      <img className="table-tile-meta-icon" src={hourglassIconSrc} alt="" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
