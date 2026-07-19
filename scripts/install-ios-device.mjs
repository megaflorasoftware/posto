import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "posto-ios-devices-"));
const devicesPath = resolve(temporaryDirectory, "devices.json");
const appPath = resolve(
  "src-tauri/gen/apple/build/posto_iOS.xcarchive/Products/Applications/Posto.app",
);

try {
  execFileSync("xcrun", ["devicectl", "list", "devices", "--json-output", devicesPath], {
    stdio: "inherit",
  });

  const deviceList = JSON.parse(readFileSync(devicesPath, "utf8"));
  const device = deviceList.result?.devices?.find(
    (candidate) =>
      candidate.hardwareProperties?.platform === "iOS" &&
      candidate.hardwareProperties?.reality === "physical" &&
      candidate.connectionProperties?.pairingState === "paired",
  );

  if (!device) {
    throw new Error("No connected, paired physical iOS device was found.");
  }

  const name = device.deviceProperties?.name ?? device.identifier;
  console.log(`Installing Posto on ${name} (${device.identifier})...`);
  execFileSync(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", device.identifier, appPath],
    { stdio: "inherit" },
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
