import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { WorkflowController } from '../workflow/workflow.controller';
import {
  LayerPublicationEntity,
  PublicationSnapshotEntity,
  RevisionParticipantEntity,
  WorkflowEventEntity,
} from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { GeometryService } from './geometry.service';
import {
  ClientMutationEntity,
  FeatureEntity,
  FeatureVersionEntity,
  LayerEntity,
  LayerFieldEntity,
  LayerGroupEntity,
  LayerRevisionEntity,
  RevisionChangeEntity,
  RevisionFeatureEntity,
} from './layer.entities';
import { LayerSchemaService } from './layer-schema.service';
import { LayerCatalogService } from './layer-catalog.service';
import { LayersController } from './layers.controller';
import { LayersService } from './layers.service';
import { RevisionConfigurationService } from './revision-configuration.service';

@Module({
  imports: [
    IdentityModule,
    TypeOrmModule.forFeature([
      LayerGroupEntity,
      LayerEntity,
      LayerRevisionEntity,
      LayerFieldEntity,
      FeatureEntity,
      FeatureVersionEntity,
      RevisionFeatureEntity,
      RevisionChangeEntity,
      ClientMutationEntity,
      RevisionParticipantEntity,
      WorkflowEventEntity,
      PublicationSnapshotEntity,
      LayerPublicationEntity,
    ]),
  ],
  controllers: [LayersController, WorkflowController],
  providers: [
    LayersService,
    LayerCatalogService,
    RevisionConfigurationService,
    GeometryService,
    LayerSchemaService,
    WorkflowService,
  ],
  exports: [LayersService, GeometryService, LayerSchemaService, WorkflowService],
})
export class LayersModule {}
