# Fase K-PRE.1.5 - Verifica finale margine

Data: 2026-07-02

## Scope

Verifica del margine architetturale su `backend/server.js` dopo K-PRE.1.1 ->
K-PRE.1.4, prima di aprire la Fase K.

## Dati rilevati

- Budget architetturale: 40500 righe (`backend/tests/architecture-line-budget.test.mjs`).
- Conteggio `backend/server.js` con lo stesso metodo del test: 37932 righe.
- Margine libero corrente: 2568 righe.
- Conteggio `wc -l backend/server.js`: 37931 righe.
- Conteggio a chiusura J14 documentato: 40496 righe.
- Riduzione ottenuta da K-PRE.1.1 -> K-PRE.1.4 rispetto a J14: circa 2564 righe.

## Confronto con Fase J

Sono stati riletti i 16 report `FASE_J*.md`.

- Minimo `server.js` documentato in J: 40495 righe.
- Massimo `server.js` documentato in J: 40499 righe.
- Spread complessivo osservato: 4 righe.
- Massimo delta positivo tra report J consecutivi: +4 righe.
- Somma dei soli delta positivi osservati nei report J: +4 righe.

La Fase J quindi e' stata praticamente neutra sul monolite: molte modifiche sono
state fatte in repository, dominio, test o moduli, senza crescere dentro
`server.js`.

## Stima per Fase K

La roadmap K prevede K0 -> K7, quindi 8 sotto-fasi. Anche assumendo una stima
molto piu' prudente dei report J, pari a 200 righe di crescita su `server.js`
per ogni sotto-fase:

- Stima prudente: 8 * 200 = 1600 righe.
- Margine corrente: 2568 righe.
- Buffer residuo dopo la stima prudente: 968 righe.

Questa stima e' volutamente superiore al comportamento osservato in J. Inoltre
K-PRE.1 ha gia' spostato gli handler pagamenti/fiscale piu' grandi nei moduli,
quindi K dovrebbe poter aggiungere nuove logiche soprattutto in
`backend/modules/`, `backend/db/relational/`, test e script, senza consumare in
modo lineare il budget di `server.js`.

## Verifiche eseguite

- `node --test backend/tests/architecture-line-budget.test.mjs`: 1/1 OK.
- Lettura dei report `FASE_J*.md` per estrarre i conteggi `server.js`.
- Conteggio diretto `wc -l backend/server.js backend/modules/payments/payments.handlers.js backend/modules/fiscal-pos/fiscal.handlers.js`.

## Decisione

PASS. Il margine e' sufficiente per aprire la Fase K senza alzare il budget.
Non serve modificare `SERVER_LINE_BUDGET`.

## STOP / REVIEW

K-PRE.1 e' chiusa. Come da roadmap, questo sblocca K-PRE.2, K-PRE.3 e K-PRE.4.
