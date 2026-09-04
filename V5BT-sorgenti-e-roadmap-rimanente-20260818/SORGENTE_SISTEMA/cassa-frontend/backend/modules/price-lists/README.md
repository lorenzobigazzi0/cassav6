# Price lists module

Modulo puro per la gestione dei listini runtime e dei prezzi temporizzati menu.

Boundary:

- normalizza fasce orarie e alias legacy (`priceSchedule`, `timedPrices`, `timePriceSchedule`, `listinoTemporizzato`);
- risolve il prezzo runtime dell'articolo senza accedere a DB, route, sessioni, pagamenti o stampa;
- calcola il bucket cache del menu in base ai confini di cambio prezzo.

Non deve importare `backend/server.js` e non deve avere side effect. I chiamanti passano `timeZone`, `appEnv` ed eventuale `env` tramite `createMenuPriceListResolver()`.
