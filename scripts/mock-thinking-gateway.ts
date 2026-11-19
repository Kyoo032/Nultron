import {
  startThinkingGateway,
  type ThinkingGatewayMode,
} from "../packages/core/src/runtime/__fixtures__/thinking-gateway";

async function main() {
  const mode = process.env.MOCK_MODE ?? "A";
  if (!["A", "B", "unfinished", "clean", "401"].includes(mode)) throw new Error("Use MOCK_MODE=A|B|unfinished|clean|401");
  const gateway = await startThinkingGateway(mode as ThinkingGatewayMode, {
    port: Number(process.env.MOCK_PORT ?? 4318),
    onRequest: (count) => console.log(`POST ${count}`),
  });
  console.log(`Thinking gateway mode ${mode}: ${gateway.url}`);
  console.log("Restart the gateway to reset the first-request failure.");
  process.once("SIGINT", () => {
    void gateway.close();
  });
  process.once("SIGTERM", () => {
    void gateway.close();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
