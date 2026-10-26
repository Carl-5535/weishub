import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import jsQR from 'jsqr'

/**
 * 加载 web/qrcodegen.js（浏览器普通脚本形态）并取回 qrcodegen 命名空间。
 * 用 Function 包裹执行的是将要发给浏览器的原始字节，测试对象与运行对象完全一致。
 */
async function loadVendor(): Promise<any> {
  const path = fileURLToPath(new URL('../web/qrcodegen.js', import.meta.url))
  const src = await readFile(path, 'utf8')
  return new Function(`${src}\n;return qrcodegen;`)()
}

/** 把矩阵渲染成白边+放大的灰度位图并用 jsqr 解码（解码即扫码器能读出的最终事实）。 */
function decodeMatrix(modules: (x: number, y: number) => boolean, size: number, scale = 4, border = 4): string | null {
  const dim = (size + border * 2) * scale
  const pixels = new Uint8ClampedArray(dim * dim * 4).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules(x, y)) continue
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = (((y + border) * scale + sy) * dim + (x + border) * scale + sx) * 4
          pixels[px] = pixels[px + 1] = pixels[px + 2] = 0
        }
      }
    }
  }
  const result = jsQR(pixels, dim, dim)
  return result ? result.data : null
}

describe('web/qrcodegen.js（内置二维码编码器）', () => {
  it('各类内容编码后都能被标准解码器扫回原文（ECC M）', async () => {
    const qrcodegen = await loadVendor()
    const samples = [
      'https://work.weixin.qq.com/ca?token=abc123&x=1',
      '你好，微枢',
      'wx-login://confirm?scene=42',
      '12345678901234567890',
      'ALPHANUMERIC-CONTENT 42',
      '中文 English 数字123 混排 😀',
    ]
    for (const text of samples) {
      const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM)
      expect(decodeMatrix((x, y) => qr.getModule(x, y), qr.size)).toBe(text)
    }
  })

  it('数据量超限时按库约定抛错，不产出损坏二维码', async () => {
    const qrcodegen = await loadVendor()
    const tooLong = 'x'.repeat(3000)
    expect(() => qrcodegen.QrCode.encodeText(tooLong, qrcodegen.QrCode.Ecc.MEDIUM)).toThrow()
  })
})
