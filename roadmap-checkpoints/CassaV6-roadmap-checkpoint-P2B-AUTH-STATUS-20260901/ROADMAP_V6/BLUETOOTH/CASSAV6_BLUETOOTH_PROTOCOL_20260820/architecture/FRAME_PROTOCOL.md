# Frame protocol

Header logico:

```text
magic
version
flags
sessionId
messageId
sequence
fragmentIndex
fragmentCount
payloadLength
messageType
```

Payload autenticato e cifrato. MTU variabile: supportare default minimo e negoziazione maggiore.
