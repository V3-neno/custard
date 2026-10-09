import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'

// design_html as the model sees it. Replaces the base entry in tools.ts once
// handlers can bring their own schema (docs/design/requests/A.md, A1).
export const htmlSchema: BetaTool = {
  name: 'design_html',
  description:
    "Creates an HTML output (a page, mockup or UI) in Design's workspace, or a new version of one. " +
    'Always send the complete document, from <!doctype html> to </html>; a fragment is refused. ' +
    'It runs in a sandbox with no network: external links, fonts and scripts will not load, so inline them or send them as local files. ' +
    'A new version keeps the local files of the version it starts from unless you replace them. ' +
    'List every skill you considered in `skills`; if the answer is a question, ask the user and stop.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name for a new output.' },
      artifact: { type: 'string', description: 'The output to change; omit for a new one.' },
      from: {
        type: 'string',
        description: 'The version to start from; omit for the selected one.'
      },
      relation: {
        type: 'string',
        enum: ['revision', 'variation'],
        description: 'revision changes it; variation adds another option beside it.'
      },
      html: { type: 'string', description: 'The complete HTML document (saved as index.html).' },
      files: {
        type: 'array',
        description: 'Local text files beside the document (CSS, JS, SVG, JSON, other pages).',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path, e.g. styles/site.css.' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      },
      references: {
        type: 'array',
        description: 'Images the user attached in this chat, copied in to be used by the page.',
        items: {
          type: 'object',
          properties: {
            attachment: { type: 'string', description: "The attached file's id or exact name." },
            path: { type: 'string', description: 'Where the page finds it, e.g. assets/logo.png.' }
          },
          required: ['attachment']
        }
      },
      skills: {
        type: 'array',
        description: 'Every skill considered, applied or not.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault path of its SKILL.md.' },
            strength: {
              type: 'string',
              enum: ['explicit', 'clear', 'similar'],
              description: 'explicit: the user named it. clear: it fits. similar: related only.'
            },
            conflicts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths of other considered skills it materially contradicts.'
            },
            material: {
              type: 'boolean',
              description: 'similar only: using it or not would noticeably change the result.'
            },
            guidance: { type: 'string', description: 'The guidance from it you relied on.' }
          },
          required: ['path', 'strength']
        }
      }
    },
    required: ['html']
  },
  eager_input_streaming: true
}
