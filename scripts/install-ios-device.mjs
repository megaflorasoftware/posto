// Installs a built app (.app or .ipa) on a paired iPhone or iPad without
// launching it.
//
//   node scripts/install-ios-device.mjs <path to .app or .ipa>
//
// DEVICE picks a device by name or identifier; by default the first paired
// device that's reachable (over USB or Wi-Fi) is used.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const appPath = process.argv[2];
if (!appPath || !existsSync(appPath)) {
  console.error(`error: no app at ${appPath ?? "(none given)"}`);
  console.error("usage: node scripts/install-ios-device.mjs <path to .app or .ipa>");
  process.exit(1);
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "posto-ios-devices-"));
const devicesPath = resolve(temporaryDirectory, "devices.json");

try {
  execFileSync("xcrun", ["devicectl", "list", "devices", "--json-output", devicesPath], {
    stdio: "ignore",
  });

  const wanted = process.env.DEVICE;
  const devices = (JSON.parse(readFileSync(devicesPath, "utf8")).result?.devices ?? []).filter(
    (candidate) =>
      candidate.hardwareProperties?.platform === "iOS" &&
      candidate.hardwareProperties?.reality === "physical" &&
      candidate.connectionProperties?.pairingState === "paired",
  );
  const device = wanted
    ? devices.find(
        (candidate) =>
          candidate.identifier === wanted ||
          candidate.hardwareProperties?.udid === wanted ||
          candidate.deviceProperties?.name === wanted,
      )
    : devices.find((candidate) => candidate.connectionProperties?.tunnelState !== "unavailable");

  if (!device) {
    const known = devices.map((candidate) => candidate.deviceProperties?.name).join(", ");
    throw new Error(
      wanted
        ? `No paired iOS device named or identified "${wanted}"${known ? ` (paired: ${known})` : ""}.`
        : `No paired iOS device is reachable${known ? ` (paired but unreachable: ${known}; unlock it, or connect it to this Mac or its Wi-Fi network)` : "; connect one and trust this Mac"}.`,
    );
  }

  const name = device.deviceProperties?.name ?? device.identifier;
  console.log(`Installing ${appPath} on ${name} (${device.identifier})...`);
  execFileSync(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", device.identifier, appPath],
    { stdio: "inherit" },
  );
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
