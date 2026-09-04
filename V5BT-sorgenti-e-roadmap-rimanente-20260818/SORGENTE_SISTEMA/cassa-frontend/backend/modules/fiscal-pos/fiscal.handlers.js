export function createFiscalHandlers({
  runFiscalCommand,
  sendJson,
  readJsonBody,
}) {
  async function handleFiscalCommand(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await runFiscalCommand(payload));
  }

  return {
    "fiscal.command": handleFiscalCommand,
  };
}
