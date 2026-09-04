import backIconSrc from "../../assets/icons/indietro.png";

type HomeBackButtonProps = {
  onClick: () => void;
  label?: string;
};

export function HomeBackButton({ onClick, label = "Home" }: HomeBackButtonProps) {
  return (
    <button className="smallbtn settings-home-btn" type="button" onClick={onClick}>
      <img className="icon settings-home-icon" src={backIconSrc} alt="" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
