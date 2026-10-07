# Moving an existing accessory

A fresh installation creates a new accessory; it is not an automatic migration
of a camera from Scrypted, Home Assistant's built-in HomeKit bridge, or another
project. Keep the existing camera running while checking this app's requirements.

For this app, back up its complete persistent data while stopped, including
`pairing.json`, `config.local.json`, and the entire hidden `.hap` directory. Restore
the complete backup on the new host, update the LAN address/source settings and
start only the new copy. Never run two instances with the same identity. Keep the
old installation stopped and available for rollback until live viewing and an
actual Apple Home recording both work.

Older standalone builds do not have the new `pairing.json` manifest. This version
deliberately stops if it finds orphaned `.hap` or configuration state. Do not delete
that state to force a fresh identity. Mapping a legacy identity into the new
manifest needs a separate, verified migration procedure; it is not automated by
this initial community release.

Even when identities and service IDs are preserved, Apple Home playback/history
must be checked after migration. The app cannot recover or inspect iCloud history.
