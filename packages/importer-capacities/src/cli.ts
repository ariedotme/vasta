#!/usr/bin/env node
// Import a Capacities space into a Vasta database.
//
//   node packages/importer-capacities/src/cli.ts --out data/vasta.db --export ~/Downloads/Capacities.zip
//
// Without --source, the database of the Capacities desktop app on this Mac is used.
// With --export (a Capacities "Full export" ZIP), media files are copied into <out dir>/media.
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { attachExportMedia, readExportArchive } from './export-media.ts'
import { mapCapacities } from './map.ts'
import { findPooledDatabases, readComponents, snapshotDatabase } from './source.ts'

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    export: { type: 'string' },
    out: { type: 'string', default: 'data/vasta.db' },
    report: { type: 'string' },
  },
})

const out = path.resolve(values.out!)
mkdirSync(path.dirname(out), { recursive: true })

let source = values.source
if (!source) {
  const [found] = findPooledDatabases()
  if (!found) {
    console.error('No Capacities database found. Open the Capacities desktop app once, or pass --source.')
    process.exit(1)
  }
  console.info(`Using ${found.logicalName} (${(found.bytes / 1e6).toFixed(1)} MB) from ${found.file}`)
  source = found.file
}

const snapshot = snapshotDatabase(source)
try {
  const result = mapCapacities(readComponents(snapshot))
  const mediaReport = values.export
    ? await attachExportMedia(readExportArchive(values.export), result.spaces, result.objects, new NodeMediaStore(path.join(path.dirname(out), 'media')))
    : undefined

  const store = new NodeStore(out)
  store.transaction(() => {
    for (const space of result.spaces) store.putSpace(space)
    for (const type of result.types) store.putType(type)
    for (const object of result.objects) store.putObject(object)
    for (const [id, raw] of result.sources) store.putImportSource(id, 'capacities', id, raw)
  })
  const counts = store.counts()
  store.close()

  const reportPath = values.report ?? `${out}.import-report.json`
  writeFileSync(reportPath, JSON.stringify({ ...result.report, ...(mediaReport ? { media: mediaReport } : {}) }, null, 2))
  console.info(`Imported into ${out}:`, counts)
  if (mediaReport) console.info(`Media: ${mediaReport.attached} files attached, ${mediaReport.withoutFile} not included in the export, ${mediaReport.unmatched.length} unmatched`)
  console.info(`Report: ${reportPath}`)
} finally {
  rmSync(snapshot, { force: true })
}
