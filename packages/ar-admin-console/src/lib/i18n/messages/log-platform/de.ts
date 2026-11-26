import type { jaLogPlatform } from './ja';

/** Monitoring → Log platform: is the log platform healthy. Spread into `../de.ts`. */
export const deLogPlatform: Record<keyof typeof jaLogPlatform, string> = {
	'lplat.page.desc': 'Ob Protokolle gespeichert werden und lesbar sind.',
	'lplat.asOf': 'Stand',
	'lplat.period':
		'Zustellzahlen gelten für die letzten 24 Stunden; das Archiv zeigt seine aktuellen Gesamtwerte.',
	'lplat.refresh': 'Aktualisieren',
	'lplat.noAccess': 'Sie haben keine Berechtigung, den Status der Protokollplattform zu sehen',
	'lplat.loadFailed': 'Der Status der Protokollplattform konnte nicht geladen werden',
	'lplat.links':
		'Die Protokolle selbst stehen unter Systemprotokolle, Auditprotokolle und Administratoraktivität',
	'lplat.flow.label': 'Protokollfluss',
	'lplat.flow.next': 'dann',

	'lplat.status': 'Status',
	'lplat.status.ok': 'In Ordnung',
	'lplat.status.warning': 'Achtung',
	'lplat.status.danger': 'Gestört',
	'lplat.status.none': '—',

	'lplat.reason.archive_unconfigured': 'Das Protokollarchiv ist nicht konfiguriert ({code})',
	'lplat.reason.archive_unreachable': 'Der Catalog liefert die Tabelle nicht ({code})',
	'lplat.reason.delivery_stuck':
		'{count} Datensätze warten seit mehr als {hours} Stunden auf den Versand',
	'lplat.reason.delivery_error': 'Der letzte Versand ist fehlgeschlagen ({code})',
	'lplat.reason.files_over_limit':
		'{files} Datendateien übersteigen die {max}, die ein Lesevorgang öffnen kann. Läuft die Verdichtung nicht, fehlt womöglich das Wartungs-Credential des Catalogs (setup update registriert es)',
	'lplat.reason.compaction_stale': 'Die Verdichtung lief seit mehr als 24 Stunden nicht',
	'lplat.reason.compaction_never': 'Die Verdichtung lief noch nie',
	'lplat.reason.read_incomplete': 'Der Lesevorgang ist nicht abgeschlossen ({code})',
	'lplat.reason.export_error': 'Der letzte Export ist fehlgeschlagen ({code})',
	'lplat.reason.export_stalled': 'Ein Export ist seit mehr als {hours} Stunden unvollendet',
	'lplat.reason.publication_stalled':
		'Ein Datensatz wird seit mehr als {hours} Stunden versiegelt (die Veröffentlichung hängt)',
	'lplat.reason.intent_orphaned':
		'{count} Datensätze blieben vor mehr als {hours} Stunden mitten im Schreiben zurück (nie bestätigt, daher nie zugestellt)',

	'lplat.stage.delivery': 'Zustellung',
	'lplat.stage.delivery.desc': 'In D1 geschriebene Datensätze auf dem Weg ins Archiv',
	'lplat.delivery.lastIngested': 'Zuletzt angenommen',
	'lplat.delivery.published': 'Versiegelt',
	'lplat.delivery.prepared': 'In Vorbereitung',
	'lplat.delivery.aborted': 'Zurückgezogen',
	'lplat.delivery.pending': 'Wartet auf Versand',
	'lplat.delivery.queued': 'In der Warteschlange',
	'lplat.delivery.ingested': 'Von der Pipeline angenommen',
	'lplat.delivery.oldest': 'Älteste wartende',
	'lplat.delivery.lastError': 'Letzter Fehler',
	'lplat.delivery.unit': 'Datensätze',
	'lplat.delivery.orphaned': 'Zurückgeblieben',
	'lplat.delivery.oldestOrphaned': 'Ältester zurückgebliebener',
	'lplat.delivery.abandoned': 'Als nie bestätigt vermerkt',
	'lplat.delivery.reclaim': 'Als nie bestätigt vermerken',
	'lplat.delivery.reclaim.done':
		'{abandoned} Datensätze wurden als nie bestätigt vermerkt (im Systemprotokoll; nach Ablauf der Aufbewahrung gelöscht)',
	'lplat.delivery.reclaim.busy': 'Eine andere Rückholung läuft; gleich neu laden',
	'lplat.delivery.reclaim.partial':
		'{abandoned} Datensätze wurden als nie bestätigt vermerkt; {failed} konnten nicht verarbeitet werden und werden beim nächsten Lauf erneut versucht',
	'lplat.delivery.reclaim.failed': 'Die Rückholung konnte nicht ausgeführt werden',
	'lplat.delivery.export.state': 'Letzter Export',
	'lplat.delivery.export.updated': 'Aktualisiert',
	'lplat.delivery.export.watermark': 'Lesemarke',

	'lplat.stage.archive': 'Protokollarchiv',
	'lplat.stage.archive.desc': 'Die Iceberg-Tabelle im R2 Data Catalog',
	'lplat.archive.readableUntil': 'Letzter Commit',
	'lplat.archive.mode': 'Modus',
	'lplat.archive.mode.pipeline': 'Pipeline (laufend)',
	'lplat.archive.mode.scheduled': 'Geplant (periodischer Export)',
	'lplat.archive.local': 'Nur lokale Zwischenspeicherung (Entwicklung)',
	'lplat.archive.generation': 'Generation',
	'lplat.archive.activated': 'Aktiviert',
	'lplat.archive.platform': 'Gesamte Plattform',
	'lplat.archive.budget': 'Genutztes Lesebudget (Dateien)',
	'lplat.archive.budget.detail': 'Datendateien {files} / {max}',
	'lplat.archive.records': 'Datensätze',
	'lplat.archive.files': 'Datendateien',
	'lplat.archive.snapshots': 'Snapshots',
	'lplat.archive.lastCommit': 'Letzter Commit',
	'lplat.archive.lastCompaction': 'Letzte Verdichtung',
	'lplat.archive.never': 'Noch keine',
	'lplat.archive.tenantNote': 'Tabellenweite Statistiken sehen nur Plattformadministratoren.',

	'lplat.stage.read': 'Protokolllesen',
	'lplat.stage.read.desc':
		'Die letzten 24 Stunden der Administratoraktivität, gelesen wie auf den Protokollseiten',
	'lplat.read.until':
		'Der neueste Commit war vor {minutes} Minuten (spätere Datensätze sind noch nicht lesbar)',
	'lplat.read.untilNow': 'Der neueste Commit war in der letzten Minute',
	'lplat.read.watermark':
		'Die Lesemarke ist {minutes} Minuten alt (gelesen wird bis zu den geprüften Exporten)',
	'lplat.read.accepted':
		'Zuletzt vor {minutes} Minuten angenommen; angenommene Datensätze werden mit dem nächsten Commit (alle paar Minuten) lesbar',
	'lplat.read.none': 'Noch keine lesbaren Datensätze',
	'lplat.read.consistency': 'Konsistenz',
	'lplat.read.consistency.eventual':
		'Die neuesten Datensätze sind möglicherweise noch nicht sichtbar',
	'lplat.read.consistency.snapshot': 'Vollständig zum Snapshot',
	'lplat.read.consistency.local_hot_only': 'Nur aktuelle Datensätze wurden gelesen',
	'lplat.read.pending': 'Warten auf Aufnahme',
	'lplat.read.noArchive': 'Keine archivierten Datensätze in diesem Zeitraum',
	'lplat.read.reason': 'Grund',

	'lplat.coverage.title': 'Audit-Abdeckung',
	'lplat.coverage.desc':
		'Das Register im Code, ob jede Administratoroperation einen Auditeintrag schreibt.',
	'lplat.coverage.covered': 'Abgedeckt',
	'lplat.coverage.gap': 'Lücken',
	'lplat.coverage.acknowledged': 'Bestätigt',
	'lplat.coverage.ignored': 'Außerhalb',
	'lplat.coverage.lastChecked': 'Zuletzt geprüft',
	'lplat.coverage.never': 'Nie',

	'lplat.catalog.title': 'Chunk-Katalog sensibler Details',
	'lplat.catalog.desc':
		'Das Verzeichnis der Chunks mit Genehmigungsdetails und den sensiblen Teilen von Webhooks. Inkonsistenzen behebt die sichere Reparatur.',
	'lplat.catalog.findings': 'Zu reparierende Befunde',
	'lplat.catalog.sensitive': 'Davon sensible Details',
	'lplat.catalog.clean': 'Keine Inkonsistenzen',
	'lplat.catalog.index': 'Index sensibler Details',
	'lplat.catalog.index.count': '{count} Zeilen',
	'lplat.catalog.index.missing': 'Keine Indextabelle',
	'lplat.catalog.index.unavailable': 'Nicht lesbar',
	'lplat.catalog.repair': 'Sichere Reparaturen anwenden',
	'lplat.catalog.repair.done': '{applied} repariert, {skipped} übersprungen',
	'lplat.catalog.repair.failed': 'Die Reparaturen konnten nicht angewendet werden'
};
