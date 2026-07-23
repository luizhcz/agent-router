import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cache de embeddings persistido em disco.
 *
 * FORMATO (decisão: um binário + um índice, por provider):
 *   .cache/embeddings/<slug-do-providerId>/
 *     ├── vectors.bin   — Float32Array little-endian concatenados, contíguos.
 *     │                    O vetor de índice i ocupa floats [i*dim, (i+1)*dim).
 *     └── manifest.json  — { version, providerId, dimensions, count,
 *                            entries: { <sha256(providerId+text)>: index } }
 *
 * Por que um único .bin + manifesto (e não um arquivo por vetor): o catálogo é
 * pequeno (~50 comandos × poucos vetores), então reescrever o arquivo inteiro
 * no flush é barato, e um só arquivo evita milhares de inodes e é trivial de
 * mmap/streamar depois. A dimensão é fixa por provider, então o offset de cada
 * vetor é puramente aritmético — o manifesto guarda só hash→índice.
 *
 * PERSISTÊNCIA: `open()` recarrega bin+manifesto, então o cache sobrevive a
 * reinício.
 *
 * CONCORRÊNCIA: todo flush (1) relê o estado em disco, (2) mescla com o
 * in-memory preservando a ordem/índices já gravados, (3) escreve em `.tmp` e
 * faz `rename` atômico (bin antes do manifesto — assim o manifesto nunca
 * referencia bytes que ainda não estão no bin). Dois processos concorrentes
 * nunca corrompem os arquivos; no pior caso um flush perde entradas do outro,
 * que viram cache-miss e são recomputadas. Endianness é a do host (arm64/x64
 * são little-endian) — o cache é local à máquina.
 */
export interface EmbeddingCacheOptions {
  /** Dimensão dos vetores deste provider. Necessária para interpretar o .bin. */
  dimensions: number;
  /** Raiz do cache. Padrão `.cache/embeddings` relativo ao cwd. */
  rootDir?: string;
  /** Flush automático a cada `set`. Padrão false (chame `flush()` em lote). */
  autoFlush?: boolean;
}

const MANIFEST_VERSION = 1;

interface Manifest {
  version: number;
  providerId: string;
  dimensions: number;
  count: number;
  entries: Record<string, number>;
}

export class EmbeddingCache {
  readonly providerId: string;
  readonly dimensions: number;
  private readonly dir: string;
  private readonly autoFlush: boolean;
  /** hash → vetor, em ordem de inserção (preserva índices já gravados). */
  private map = new Map<string, Float32Array>();

  private constructor(
    providerId: string,
    dimensions: number,
    dir: string,
    autoFlush: boolean,
  ) {
    this.providerId = providerId;
    this.dimensions = dimensions;
    this.dir = dir;
    this.autoFlush = autoFlush;
  }

  /** Abre (ou cria) o cache do provider e carrega o que houver em disco. */
  static async open(
    providerId: string,
    opts: EmbeddingCacheOptions,
  ): Promise<EmbeddingCache> {
    const root = opts.rootDir ?? join('.cache', 'embeddings');
    const dir = join(root, slug(providerId));
    const cache = new EmbeddingCache(
      providerId,
      opts.dimensions,
      dir,
      opts.autoFlush ?? false,
    );
    await mkdir(dir, { recursive: true });
    cache.map = await loadFromDisk(dir, providerId, opts.dimensions);
    return cache;
  }

  get size(): number {
    return this.map.size;
  }

  private keyFor(text: string): string {
    return createHash('sha256').update(this.providerId).update('\0').update(text).digest('hex');
  }

  has(text: string): boolean {
    return this.map.has(this.keyFor(text));
  }

  /** Retorna uma CÓPIA do vetor cacheado (o buffer interno não escapa). */
  get(text: string): Float32Array | undefined {
    const v = this.map.get(this.keyFor(text));
    return v ? v.slice() : undefined;
  }

  /** Guarda em memória (cópia defensiva). Persiste só em `flush()`. */
  set(text: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `EmbeddingCache(${this.providerId}): vetor com ${vector.length} dims, ` +
          `esperado ${this.dimensions}.`,
      );
    }
    this.map.set(this.keyFor(text), vector.slice());
    if (this.autoFlush) {
      // Best-effort: `set` é síncrono, então o flush roda em background. Para
      // garantia de durabilidade prefira `flush()`/`getOrCompute()` explícitos.
      void this.flush().catch(() => {});
    }
  }

  /**
   * Padrão de integração: resolve `texts` do cache, computa só os que faltam via
   * `compute`, persiste e devolve todos os vetores na ordem de entrada.
   */
  async getOrCompute(
    texts: string[],
    compute: (missing: string[]) => Promise<Float32Array[]>,
  ): Promise<Float32Array[]> {
    const missing: string[] = [];
    for (const t of texts) {
      if (!this.has(t)) missing.push(t);
    }
    if (missing.length > 0) {
      const computed = await compute(missing);
      if (computed.length !== missing.length) {
        throw new Error(
          `EmbeddingCache(${this.providerId}): compute devolveu ${computed.length} ` +
            `vetores para ${missing.length} textos.`,
        );
      }
      for (let i = 0; i < missing.length; i++) {
        this.set(missing[i]!, computed[i]!);
      }
      await this.flush();
    }
    return texts.map((t) => this.get(t)!);
  }

  /** Persiste atomicamente, mesclando com o estado em disco (concorrência). */
  async flush(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    // 1) Relê o disco e mescla preservando a ordem já gravada lá.
    const disk = await loadFromDisk(this.dir, this.providerId, this.dimensions);
    for (const [hash, vec] of this.map) {
      disk.set(hash, vec); // in-memory vence; chaves novas vão para o fim.
    }
    this.map = disk;

    // 2) Serializa bin + manifesto.
    const count = this.map.size;
    const dim = this.dimensions;
    const flat = new Float32Array(count * dim);
    const entries: Record<string, number> = {};
    let i = 0;
    for (const [hash, vec] of this.map) {
      flat.set(vec, i * dim);
      entries[hash] = i;
      i++;
    }
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      providerId: this.providerId,
      dimensions: dim,
      count,
      entries,
    };

    // 3) Escreve .tmp e faz rename atômico — bin ANTES do manifesto.
    const binPath = join(this.dir, 'vectors.bin');
    const manPath = join(this.dir, 'manifest.json');
    const binTmp = `${binPath}.${process.pid}.tmp`;
    const manTmp = `${manPath}.${process.pid}.tmp`;

    const binBuf = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
    await writeFile(binTmp, binBuf);
    await rename(binTmp, binPath);
    await writeFile(manTmp, JSON.stringify(manifest));
    await rename(manTmp, manPath);
  }

  /** Apaga o cache do provider em memória e em disco. */
  async clear(): Promise<void> {
    this.map = new Map();
    await rm(this.dir, { recursive: true, force: true });
  }
}

async function loadFromDisk(
  dir: string,
  providerId: string,
  dimensions: number,
): Promise<Map<string, Float32Array>> {
  const manPath = join(dir, 'manifest.json');
  const binPath = join(dir, 'vectors.bin');
  const map = new Map<string, Float32Array>();

  if (!existsSync(manPath) || !existsSync(binPath)) return map;

  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manPath, 'utf8')) as Manifest;
  } catch {
    return map; // manifesto corrompido/parcial → trata como cache vazio.
  }

  // Provider ou dimensão divergente invalida o cache (fingerprint mudou).
  if (
    manifest.version !== MANIFEST_VERSION ||
    manifest.providerId !== providerId ||
    manifest.dimensions !== dimensions
  ) {
    return map;
  }

  const raw = await readFile(binPath);
  // Copia para um ArrayBuffer alinhado a 4 bytes antes da view Float32.
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const floats = new Float32Array(ab);
  const dim = dimensions;

  // Reinsere na ordem de índice para manter offsets estáveis entre flushes.
  const ordered = Object.entries(manifest.entries).sort((a, b) => a[1] - b[1]);
  for (const [hash, idx] of ordered) {
    const start = idx * dim;
    if (start + dim > floats.length) continue; // bin truncado/inconsistente.
    map.set(hash, floats.slice(start, start + dim));
  }
  return map;
}

/** Nome de diretório seguro e único a partir do providerId (que tem `/` e `:`). */
function slug(providerId: string): string {
  const safe = providerId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const short = createHash('sha256').update(providerId).digest('hex').slice(0, 8);
  return `${safe}_${short}`;
}
