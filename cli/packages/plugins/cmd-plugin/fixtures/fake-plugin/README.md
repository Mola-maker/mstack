# fake-plugin — the `mola plugin install` fixture

A minimal, build-free third-party plugin used by the cmd-plugin tests and by
the B2 acceptance command:

```sh
mola plugin install ./packages/plugins/cmd-plugin/fixtures/fake-plugin --yes
```

It is a `command`-kind plugin that registers `mola fake hello`. The manifest
declares a small permission set (`fs.read: ~/.mola/**`, `env.read: MOLA_*`,
mola capabilities) so the install-time permission diff has something to show.

Installing it from a local directory yields the **`untrusted`** trust tier
(ADR-0002 §2: a local path is never `verified`), and `~/.mola/plugins.json`
records the SHA-512 pin of the installed tree.
