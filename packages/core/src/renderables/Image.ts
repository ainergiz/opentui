import { Jimp } from "jimp"
import { type RenderableOptions, Renderable } from "../Renderable"
import type { OptimizedBuffer } from "../buffer"
import { RGBA } from "../lib/RGBA"
import { ANSI } from "../ansi"
import type { RenderContext } from "../types"

type ImageSource = string | ArrayBuffer | Uint8Array

type ImageFit = "contain" | "cover" | "fill"

export interface ImageOptions extends RenderableOptions<ImageRenderable> {
  src: ImageSource
  alt?: string
  fit?: ImageFit
}

interface EncodedImagePayload {
  chunks: string[]
}

const MAX_KITTY_CHUNK_SIZE = 4096
let imageIdCounter = 1

export class ImageRenderable extends Renderable {
  private _src: ImageSource
  private _alt?: string
  private _fit: ImageFit
  private imagePayload: EncodedImagePayload | null = null
  private loadToken = 0
  private sourceVersion = 0
  private renderKey = ""
  private loadingKey: string | null = null
  private readonly imageId = imageIdCounter++
  private lastScaledSize: { width: number; height: number } | null = null

  constructor(ctx: RenderContext, options: ImageOptions) {
    super(ctx, options)
    this._src = options.src
    this._alt = options.alt
    this._fit = options.fit ?? "contain"
  }

  public get src(): ImageSource {
    return this._src
  }

  public set src(value: ImageSource) {
    this._src = value
    this.sourceVersion += 1
    this.invalidateImage()
  }

  public get alt(): string | undefined {
    return this._alt
  }

  public set alt(value: string | undefined) {
    this._alt = value
    this.requestRender()
  }

  public get fit(): ImageFit {
    return this._fit
  }

  public set fit(value: ImageFit) {
    this._fit = value
    this.invalidateImage()
  }

  protected onResize(): void {
    this.invalidateImage()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return

    if (!this.canRenderKittyGraphics()) {
      this.renderFallback(buffer)
      return
    }

    this.ensureImagePayload()

    if (!this.imagePayload) {
      this.renderFallback(buffer)
      return
    }

    this.clearRegion(buffer)
    this.queueKittyImage()
  }

  private invalidateImage(): void {
    this.imagePayload = null
    this.lastScaledSize = null
    this.requestRender()
  }

  private canRenderKittyGraphics(): boolean {
    return !!this._ctx.capabilities?.kitty_graphics
  }

  private ensureImagePayload(): void {
    if (this.width <= 0 || this.height <= 0) return

    const resolutionKey = this._ctx.resolution
      ? `${this._ctx.resolution.width}x${this._ctx.resolution.height}`
      : "unknown"
    const nextRenderKey = `${this.sourceVersion}:${this.width}x${this.height}:${resolutionKey}:${this._fit}`

    if (this.imagePayload && this.renderKey === nextRenderKey) {
      return
    }

    if (this.loadingKey === nextRenderKey) {
      return
    }

    this.renderKey = nextRenderKey
    this.loadingKey = nextRenderKey
    this.loadImagePayload().catch((error) => {
      if (process.env.NODE_ENV !== "production") {
        console.error("Failed to load image payload:", error)
      }
      this.imagePayload = null
      this.loadingKey = null
    })
  }

  private async loadImagePayload(): Promise<void> {
    const currentToken = ++this.loadToken
    try {
      const sourceBuffer = await this.loadSourceBuffer()
      const image = await Jimp.read(sourceBuffer)

      const targetSize = this.getTargetPixelSize(image.bitmap.width, image.bitmap.height)
      if (targetSize) {
        if (this._fit === "cover") {
          image.cover({ w: targetSize.width, h: targetSize.height })
        } else if (this._fit === "contain") {
          image.contain({
            w: targetSize.width,
            h: targetSize.height,
            align: Jimp.HORIZONTAL_ALIGN_CENTER,
            valign: Jimp.VERTICAL_ALIGN_MIDDLE,
          })
        } else {
          image.resize({ w: targetSize.width, h: targetSize.height })
        }
      }

      const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG)
      const encodedData = pngBuffer.toString("base64")
      const chunks = this.chunkKittyData(encodedData)

      if (currentToken !== this.loadToken) {
        return
      }

      this.imagePayload = { chunks }
      this.requestRender()
    } finally {
      if (currentToken === this.loadToken) {
        this.loadingKey = null
      }
    }
  }

  private async loadSourceBuffer(): Promise<ArrayBuffer> {
    if (typeof this._src === "string") {
      if (this._src.startsWith("data:")) {
        const base64 = this._src.split(",")[1]
        if (!base64) {
          throw new Error("Invalid data URL for image source")
        }
        const decoded = Buffer.from(base64, "base64")
        return decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength)
      }

      return Bun.file(this._src).arrayBuffer()
    }

    if (this._src instanceof ArrayBuffer) {
      return this._src
    }

    if (ArrayBuffer.isView(this._src)) {
      return this._src.buffer.slice(this._src.byteOffset, this._src.byteOffset + this._src.byteLength)
    }

    throw new Error("Unsupported image source")
  }

  private getTargetPixelSize(imageWidth: number, imageHeight: number): { width: number; height: number } | null {
    const resolution = this._ctx.resolution
    if (!resolution) {
      return null
    }

    const cellWidth = resolution.width / this._ctx.width
    const cellHeight = resolution.height / this._ctx.height

    const targetWidth = Math.max(1, Math.round(this.width * cellWidth))
    const targetHeight = Math.max(1, Math.round(this.height * cellHeight))

    if (this.lastScaledSize && this.lastScaledSize.width === targetWidth && this.lastScaledSize.height === targetHeight) {
      return this.lastScaledSize
    }

    this.lastScaledSize = { width: targetWidth, height: targetHeight }

    if (this._fit === "fill") {
      return this.lastScaledSize
    }

    const scale =
      this._fit === "cover"
        ? Math.max(targetWidth / imageWidth, targetHeight / imageHeight)
        : Math.min(targetWidth / imageWidth, targetHeight / imageHeight)

    return {
      width: Math.max(1, Math.round(imageWidth * scale)),
      height: Math.max(1, Math.round(imageHeight * scale)),
    }
  }

  private chunkKittyData(data: string): string[] {
    const chunks: string[] = []
    for (let i = 0; i < data.length; i += MAX_KITTY_CHUNK_SIZE) {
      chunks.push(data.slice(i, i + MAX_KITTY_CHUNK_SIZE))
    }
    return chunks
  }

  private queueKittyImage(): void {
    if (!this.imagePayload) return

    const row = this.y + 1
    const col = this.x + 1
    const params = `a=T,f=100,c=${this.width},r=${this.height},i=${this.imageId}`

    let output = `\x1b7${ANSI.moveCursor(row, col)}`

    const lastChunkIndex = this.imagePayload.chunks.length - 1
    this.imagePayload.chunks.forEach((chunk, index) => {
      const hasMore = index < lastChunkIndex
      const moreFlag = hasMore ? ",m=1" : ",m=0"
      output += `\x1b_G${params}${moreFlag};${chunk}\x1b\\`
    })

    output += "\x1b8"
    this._ctx.enqueuePostRenderOutput(output)
  }

  private clearRegion(buffer: OptimizedBuffer): void {
    const transparent = RGBA.fromValues(0, 0, 0, 0)
    for (let row = 0; row < this.height; row += 1) {
      for (let col = 0; col < this.width; col += 1) {
        buffer.setCell(this.x + col, this.y + row, " ", transparent, transparent)
      }
    }
  }

  private renderFallback(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return

    const fallback = this._alt ?? "[image]"
    const trimmed = fallback.slice(0, Math.max(0, this.width))
    buffer.drawText(trimmed, this.x, this.y, RGBA.fromValues(1, 1, 1, 1))
  }
}
