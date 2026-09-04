import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TableDetailAnagraphicFields } from "../src/pages/home/tables/components/TableDetailAnagraphicFields";

afterEach(() => {
  cleanup();
});

const buildProps = () => ({
  draftName: "",
  draftPhone: "",
  draftCovers: "2",
  draftNote: "",
  hasAllergyAlert: false,
  selectedAllergens: [] as string[],
  draftManualIntolerance: "",
  allergenOptions: ["Glutine", "Latte"] as const,
  showReservationFields: false,
  showPhoneField: true,
  reservationTime: "",
  busy: false,
  onChangeName: vi.fn(),
  onChangePhone: vi.fn(),
  onChangeCovers: vi.fn(),
  onChangeNote: vi.fn(),
  onCommitAllergies: vi.fn(),
  onChangeReservationTime: vi.fn(),
});

/** Allergie e intolleranze si modificano solo dalla modale, aperta dalla matita. */
const apriModale = () => {
  fireEvent.click(screen.getByRole("button", { name: "Modifica allergie e intolleranze" }));
  return screen.getByRole("dialog");
};

describe("TableDetailAnagraphicFields", () => {
  it("mostra le etichette richieste in maiuscolo", () => {
    render(<TableDetailAnagraphicFields {...buildProps()} />);

    expect(screen.getByText("NOME TAVOLO")).toBeInTheDocument();
    expect(screen.getByText("TELEFONO")).toBeInTheDocument();
    expect(screen.getByText("COPERTI")).toBeInTheDocument();
    expect(screen.getByText("NOTE")).toBeInTheDocument();
    expect(screen.getByText("ALLERGIE / INTOLLERANZE")).toBeInTheDocument();
  });

  it("non espone piu la spunta: la sezione si modifica dalla matita", () => {
    render(<TableDetailAnagraphicFields {...buildProps()} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Modifica allergie e intolleranze" })
    ).toBeInTheDocument();
  });

  it("aggiunge un'intolleranza manuale e la consegna solo alla conferma", () => {
    const props = buildProps();
    render(<TableDetailAnagraphicFields {...props} />);
    const modale = apriModale();

    fireEvent.change(within(modale).getByLabelText(/INTOLLERANZA MANUALE/), {
      target: { value: "Nickel" },
    });
    fireEvent.click(
      within(modale).getByRole("button", { name: "Aggiungi allergia o intolleranza manuale" })
    );

    // Finche non si conferma, il chiamante non deve vedere nulla.
    expect(props.onCommitAllergies).not.toHaveBeenCalled();
    expect(within(modale).getByRole("button", { name: "Rimuovi Nickel" })).toBeInTheDocument();

    fireEvent.click(within(modale).getByRole("button", { name: "CONFERMA" }));
    expect(props.onCommitAllergies).toHaveBeenCalledWith([], "Nickel");
  });

  it("seleziona un allergene e lo consegna alla conferma", () => {
    const props = buildProps();
    render(<TableDetailAnagraphicFields {...props} />);
    const modale = apriModale();

    fireEvent.click(within(modale).getByRole("button", { name: /Glutine/ }));
    fireEvent.click(within(modale).getByRole("button", { name: "CONFERMA" }));

    expect(props.onCommitAllergies).toHaveBeenCalledWith(["Glutine"], "");
  });

  it("annullando la modale non consegna nulla", () => {
    const props = buildProps();
    render(<TableDetailAnagraphicFields {...props} />);
    const modale = apriModale();

    fireEvent.click(within(modale).getByRole("button", { name: /Latte/ }));
    fireEvent.click(within(modale).getByRole("button", { name: "ANNULLA" }));

    expect(props.onCommitAllergies).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("la rimozione di una card manuale chiede conferma, e annullando la card resta", () => {
    const props = { ...buildProps(), draftManualIntolerance: "Nickel" };
    render(<TableDetailAnagraphicFields {...props} />);
    const modale = apriModale();

    fireEvent.click(within(modale).getByRole("button", { name: "Rimuovi Nickel" }));
    const conferma = screen.getByRole("alertdialog");
    expect(conferma).toHaveTextContent("CONFERMI LA RIMOZIONE DI Nickel?");

    fireEvent.click(within(conferma).getByRole("button", { name: "ANNULLA" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(within(modale).getByRole("button", { name: "Rimuovi Nickel" })).toBeInTheDocument();
  });

  it("la rimozione confermata toglie la card e la conferma la consegna vuota", () => {
    const props = { ...buildProps(), draftManualIntolerance: "Nickel" };
    render(<TableDetailAnagraphicFields {...props} />);
    const modale = apriModale();

    fireEvent.click(within(modale).getByRole("button", { name: "Rimuovi Nickel" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "CONFERMA" })
    );

    expect(within(modale).queryByRole("button", { name: "Rimuovi Nickel" })).not.toBeInTheDocument();
    fireEvent.click(within(modale).getByRole("button", { name: "CONFERMA" }));
    expect(props.onCommitAllergies).toHaveBeenCalledWith([], "");
  });

  it("l'anteprima resta visibile senza aprire la modale", () => {
    const props = {
      ...buildProps(),
      hasAllergyAlert: true,
      selectedAllergens: ["Glutine"],
      draftManualIntolerance: "Nickel",
    };
    render(<TableDetailAnagraphicFields {...props} />);

    const anteprima = document.querySelector(".table-detail-allergy-preview");
    expect(anteprima).not.toBeNull();
    expect(anteprima).toHaveTextContent("Glutine");
    expect(anteprima).toHaveTextContent("Nickel");
  });
});
