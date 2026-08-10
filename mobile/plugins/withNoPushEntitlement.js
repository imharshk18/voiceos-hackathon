const { withFinalizedMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Mise only schedules local cooking timers. Those work without Apple's remote
 * Push Notifications entitlement, which lets the app run on a free Personal
 * Team during development.
 */
module.exports = function withNoPushEntitlement(config) {
  return withFinalizedMod(config, ["ios", async (config) => {
    const projectName = config.modRequest.projectName;
    const entitlementsPath = path.join(
      config.modRequest.platformProjectRoot,
      projectName,
      `${projectName}.entitlements`,
    );

    if (fs.existsSync(entitlementsPath)) {
      const contents = await fs.promises.readFile(entitlementsPath, "utf8");
      const withoutPushEntitlement = contents.replace(
        /\s*<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/,
        "",
      );
      if (withoutPushEntitlement !== contents) {
        await fs.promises.writeFile(entitlementsPath, withoutPushEntitlement);
      }
    }

    return config;
  }]);
};
