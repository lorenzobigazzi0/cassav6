# Futuro — multi-hop e load balancing

Non implementare in questo incremento.

Il protocollo v1 riserva campi:

```text
originNodeId
destinationNodeId
hopCount
maxHops
routeId
custodyAck
serverAck
aggregateId
```

La fase futura abiliterà:

```text
P1 → P2 → P3 → Raspberry
sticky routing per aggregato
weighted rendezvous hashing
route expiry
multi-path per priorità alte
server-side command_inbox dedup
```
