/**
 * The fake plugin's entry point (ADR-0002 manifest `entry.ts` → an ES module
 * that default-exports a Plugin). It registers one command so the installed
 * fixture is visibly functional after `mola plugin install`:
 *
 *   mola fake hello   →   hello from mola-fake-plugin
 *
 * The file is plain JavaScript on purpose: the fixture must install and
 * activate without a build step.
 */

export default {
  activate(ctx) {
    ctx.commands.register({
      path: ["fake", "hello"],
      description: "fake plugin greeting (install fixture)",
      async handler(_args, io) {
        io.data({ from: ctx.id, version: ctx.manifest.version });
        if (!io.json) io.out(`hello from ${ctx.id}`);
        return 0;
      },
    });
  },
};
