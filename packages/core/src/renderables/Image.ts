import { ptr } from "bun:ffi"
import { Jimp } from "jimp"
import { Renderable, type RenderableOptions } from "../Renderable"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA"
import type { RenderContext } from "../types"
import type { OptimizedBuffer } from "../buffer"

export type ImageFit = "contain" | "cover" | "fill"
export type ImageSource = string | ArrayBuffer | Uint8Array

export interface ImageOptions extends RenderableOptions<ImageRenderable> {
  src: ImageSource
  fit?: ImageFit
  backgroundColor?: ColorInput
}

export class ImageRenderable extends Renderable {
  private source: ImageSource
  private fitMode: ImageFit
  private backgroundColorValue: RGBA
  private image: Jimp | null = null
  private imageData: Uint8Array | null = null
  private alignedBytesPerRow = 0
  private loadToken = 0
  private needsRedraw = true
  private lastPixelWidth = 0
  private lastPixelHeight = 0

  constructor(ctx: RenderContext, options: ImageOptions) {
    super(ctx, {
      ...options,
      buffered: true,
    })

    this.source = options.src
    this.fitMode = options.fit ?? "contain"
    this.backgroundColorValue = options.backgroundColor
      ? parseColor(options.backgroundColor)
      : RGBA.fromValues(0, 0, 0, 0)

    void this.loadSource(this.source)
  }

  public get src(): ImageSource {
    return this.source
  }

  public set src(value: ImageSource) {
    if (this.source === value) return
    this.source = value
    void this.loadSource(value)
  }

  public get fit(): ImageFit {
    return this.fitMode
  }

  public set fit(value: ImageFit | null) {
    const next = value ?? "contain"
    if (this.fitMode === next) return
    this.fitMode = next
    this.needsRedraw = true
    this.requestRender()
  }

  public get backgroundColor(): RGBA {
    return this.backgroundColorValue
  }

  public set backgroundColor(value: ColorInput | null) {
    const next = value ? parseColor(value) : RGBA.fromValues(0, 0, 0, 0)
    if (this.sameColor(this.backgroundColorValue, next)) return
    this.backgroundColorValue = next
    this.needsRedraw = true
    this.requestRender()
  }

  protected override onResize(_width: number, _height: number): void {
    this.needsRedraw = true
    this.requestRender()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this.buffered && !this.frameBuffer) {
      return
    }

    if (!this.image) {
      buffer.clear(this.backgroundColorValue)
      return
    }

    if (!this.needsRedraw) return

    const targetWidth = this.width * 2
    const targetHeight = this.height * 2

    if (targetWidth <= 0 || targetHeight <= 0) {
      return
    }

    if (!this.imageData || targetWidth !== this.lastPixelWidth || targetHeight !== this.lastPixelHeight) {
      const raster = this.rasterizeImage(this.image, targetWidth, targetHeight)
      this.imageData = raster.data
      this.alignedBytesPerRow = raster.alignedBytesPerRow
      this.lastPixelWidth = targetWidth
      this.lastPixelHeight = targetHeight
    }

    buffer.clear(this.backgroundColorValue)
    buffer.drawSuperSampleBuffer(
      0,
      0,
      ptr(this.imageData),
      this.imageData.length,
      "rgba8unorm",
      this.alignedBytesPerRow,
    )

    this.needsRedraw = false
  }

  private async loadSource(source: ImageSource): Promise<void> {
    const token = ++this.loadToken

    try {
      const arrayBuffer = await this.readSource(source)
      const image = await Jimp.read(arrayBuffer)

      if (token !== this.loadToken) return

      this.image = image
      this.needsRedraw = true
      this.requestRender()
    } catch (error) {
      console.error("[ImageRenderable] Failed to load image source:", error)
    }
  }

  private async readSource(source: ImageSource): Promise<ArrayBuffer> {
    if (typeof source === "string") {
      return await Bun.file(source).arrayBuffer()
    }

    if (source instanceof ArrayBuffer) {
      return source
    }

    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
  }

  private rasterizeImage(image: Jimp, targetWidth: number, targetHeight: number): {
    data: Uint8Array
    alignedBytesPerRow: number
  } {
    const sourceWidth = image.bitmap.width
    const sourceHeight = image.bitmap.height

    const resized = image.clone()
    let output = resized

    if (this.fitMode === "fill") {
      resized.resize(targetWidth, targetHeight)
    } else {
      const scale =
        this.fitMode === "cover"
          ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
          : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)

      const scaledWidth = Math.max(1, Math.round(sourceWidth * scale))
      const scaledHeight = Math.max(1, Math.round(sourceHeight * scale))

      resized.resize(scaledWidth, scaledHeight)

      if (this.fitMode === "cover") {
        const cropX = Math.max(0, Math.floor((scaledWidth - targetWidth) / 2))
        const cropY = Math.max(0, Math.floor((scaledHeight - targetHeight) / 2))
        resized.crop(cropX, cropY, targetWidth, targetHeight)
      } else {
        const background = this.getBackgroundInt()
        const canvas = new Jimp({ width: targetWidth, height: targetHeight, color: background })
        const offsetX = Math.max(0, Math.floor((targetWidth - scaledWidth) / 2))
        const offsetY = Math.max(0, Math.floor((targetHeight - scaledHeight) / 2))
        canvas.composite(resized, offsetX, offsetY)
        output = canvas
      }
    }

    return {
      data: output.bitmap.data,
      alignedBytesPerRow: output.bitmap.width * 4,
    }
  }

  private getBackgroundInt(): number {
    const [r, g, b, a] = this.backgroundColorValue.toInts()
    return Jimp.rgbaToInt(r, g, b, a)
  }

  private sameColor(a: RGBA, b: RGBA): boolean {
    return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
  }
}
