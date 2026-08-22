import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import type { PublicationJobListQueryDto, PublicationJobPage } from './publication.dto';
import { PublicationJobRepository } from './publication-job.repository';
import { publicationJobEtag, publicationJobView } from './publication-view';

interface PublicationCursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class PublicationQueryService {
  constructor(
    private readonly repository: PublicationJobRepository,
    private readonly crypto: CryptoService,
  ) {}

  async get(jobId: string) {
    const row = await this.repository.findById(jobId);
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy tác vụ công bố.');
    return { data: publicationJobView(row), etag: publicationJobEtag(row.id, row.lockVersion) };
  }

  async list(layerId: string, query: PublicationJobListQueryDto) {
    if (!(await this.repository.layerExists(layerId))) {
      throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
    }
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const rows = await this.repository.listForLayer(layerId, query, cursor);
    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    const page: PublicationJobPage = {
      items: pageRows.map(publicationJobView),
      nextCursor:
        hasMore && last
          ? this.encodeCursor({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })
          : null,
      hasMore,
      limit: query.limit,
    };
    return { data: page, etag: `"publication-jobs-${this.crypto.checksum(JSON.stringify(page))}"` };
  }

  private encodeCursor(cursor: PublicationCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string): PublicationCursor {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding');
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<PublicationCursor>;
      if (
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(new Date(parsed.createdAt).getTime()) ||
        typeof parsed.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          parsed.id,
        )
      ) {
        throw new Error('invalid cursor');
      }
      return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
    } catch {
      throw new AppException(400, 'VALIDATION_FAILED', 'Cursor không hợp lệ.');
    }
  }
}
