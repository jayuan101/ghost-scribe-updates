'use strict'

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType,
} = require('docx')

async function generateDocx({ summary, toneAnalysis, sessionDate }) {
  const children = []

  // ── Title ──────────────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      text: 'Ghost Scribe Transcript',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [new TextRun({ text: sessionDate || new Date().toLocaleString(), color: '888888', size: 20 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
  )

  // ── Session stats ──────────────────────────────────────────────────────────
  if (summary) {
    const dur = summary.duration || 0
    const mins = String(Math.floor(dur / 60)).padStart(2, '0')
    const secs = String(dur % 60).padStart(2, '0')

    children.push(
      new Paragraph({ text: 'Session Overview', heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 120 } }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Duration: ', bold: true }),
          new TextRun(`${mins}:${secs}`),
          new TextRun({ text: '    Speakers detected: ', bold: true }),
          new TextRun(String(summary.speakerCount || 0)),
        ],
        spacing: { after: 200 },
      }),
    )

    // Speaker stats table
    if (summary.speakers?.length) {
      children.push(new Paragraph({ text: 'Speaker Statistics', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 120 } }))

      const headerRow = new TableRow({
        children: ['Speaker', 'Words', 'WPM', 'Talking %', 'Confidence'].map(t =>
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 20 })] })],
            shading: { type: ShadingType.SOLID, color: '1a1a2e', fill: '1a1a2e' },
          }),
        ),
        tableHeader: true,
      })

      const dataRows = summary.speakers.map((spk, i) => {
        const name = (toneAnalysis?.speakers?.[String(spk.id + 1)]?.name) || `Speaker ${spk.id + 1}`
        const conf = Math.round((spk.avgConfidence || 0) * 100)
        const rowColor = i % 2 === 0 ? 'f8f8ff' : 'ffffff'
        return new TableRow({
          children: [name, String(spk.wordCount), String(spk.wpm), `${spk.talkingShare}%`, `${conf}% (${spk.confidenceLabel})`].map(t =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: t, size: 20 })] })],
              shading: { type: ShadingType.SOLID, color: rowColor, fill: rowColor },
            }),
          ),
        })
      })

      children.push(
        new Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
        new Paragraph({ text: '', spacing: { after: 200 } }),
      )
    }
  }

  // ── Tone analysis ──────────────────────────────────────────────────────────
  if (toneAnalysis && !toneAnalysis.error && toneAnalysis.speakers) {
    children.push(new Paragraph({ text: 'Tone & Sentiment Analysis', heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }))

    if (toneAnalysis.overall_dynamic) {
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Overall: ', bold: true }), new TextRun(toneAnalysis.overall_dynamic)],
        spacing: { after: 120 },
      }))
    }

    if (toneAnalysis.key_topics?.length) {
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Topics: ', bold: true }), new TextRun(toneAnalysis.key_topics.join(', '))],
        spacing: { after: 160 },
      }))
    }

    for (const [id, a] of Object.entries(toneAnalysis.speakers)) {
      const name = a.name || `Speaker ${id}`
      children.push(
        new Paragraph({
          children: [new TextRun({ text: name, bold: true, size: 22 })],
          spacing: { before: 120, after: 60 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: '4A9EFF' } },
          indent: { left: 120 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Tone: ', bold: true }), new TextRun(a.tone || '–'),
            new TextRun({ text: '   Sentiment: ', bold: true }), new TextRun(a.sentiment || '–'),
          ],
          indent: { left: 120 },
          spacing: { after: a.observation ? 40 : 120 },
        }),
      )
      if (a.observation) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'Note: ', bold: true }), new TextRun(a.observation)],
          indent: { left: 120 },
          spacing: { after: 120 },
        }))
      }
    }
  }

  // ── Full transcript ────────────────────────────────────────────────────────
  if (summary?.fullTranscript) {
    children.push(new Paragraph({ text: 'Full Transcript', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 160 } }))

    const lines = summary.fullTranscript.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      const match = line.match(/^\[Speaker (\d+)\]: (.+)$/)
      if (match) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `Speaker ${match[1]}: `, bold: true, color: '4A9EFF', size: 20 }),
            new TextRun({ text: match[2], size: 20 }),
          ],
          spacing: { after: 80 },
        }))
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })], spacing: { after: 80 } }))
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
      },
    },
    sections: [{ properties: {}, children }],
  })

  return Packer.toBuffer(doc)
}

module.exports = { generateDocx }
