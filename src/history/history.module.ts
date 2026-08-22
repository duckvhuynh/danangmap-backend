import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { HistoryController } from './history.controller';
import { HistoryQueryService } from './history-query.service';
import { PublicationRollbackService } from './publication-rollback.service';

@Module({
  imports: [IdentityModule],
  controllers: [HistoryController],
  providers: [HistoryQueryService, PublicationRollbackService],
})
export class HistoryModule {}
