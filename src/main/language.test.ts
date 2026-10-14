import { describe, expect, it } from 'vitest'
import { foreignScript } from './language'

describe('foreignScript', () => {
  it('spots a Chinese summary of an English chat', () => {
    expect(foreignScript('make the queue tool retry', '用户希望队列工具重试')).toBe(
      'Chinese or Japanese'
    )
  })
  it('allows a summary in the script the user wrote in', () => {
    expect(foreignScript('请帮我改一下', '用户希望修改')).toBeNull()
    expect(foreignScript('Привет, помоги', 'Пользователь просит помощи')).toBeNull()
    expect(foreignScript('fixa köfunktionen', 'Användaren vill fixa kön')).toBeNull()
  })
  it('ignores a few stray characters', () => {
    expect(foreignScript('play 東京 by someone', 'Played the song 東京')).toBeNull()
    expect(foreignScript('hi', 'Uses π and µ')).toBeNull()
  })
  it('checks every script', () => {
    expect(foreignScript('hello', 'Пользователь хочет')).toBe('Cyrillic')
    expect(foreignScript('hello', '사용자가 원하는')).toBe('Korean')
  })
})
