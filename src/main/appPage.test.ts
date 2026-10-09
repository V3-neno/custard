import { describe, expect, it } from 'vitest'
import { sameAppPage } from './appPage'

describe('sameAppPage', () => {
  const file = 'file:///opt/Custard/resources/app.asar/out/renderer/index.html'
  it('accepts the app page, with a hash or query', () => {
    expect(sameAppPage(file, file)).toBe(true)
    expect(sameAppPage(file + '#/chat', file)).toBe(true)
    expect(sameAppPage('http://localhost:5173/', 'http://localhost:5173/')).toBe(true)
  })
  it('refuses any other page', () => {
    expect(sameAppPage('http://127.0.0.1:8777/', file)).toBe(false)
    expect(sameAppPage('file:///etc/passwd', file)).toBe(false)
    expect(sameAppPage('https://evil.example/', 'http://localhost:5173/')).toBe(false)
    expect(sameAppPage('http://localhost:5174/', 'http://localhost:5173/')).toBe(false)
    expect(sameAppPage('not a url', file)).toBe(false)
  })
})
