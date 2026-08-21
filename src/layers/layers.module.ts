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
import { LayersController } from './layers.controller';
import { LayersService } from './layers.service';

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
  providers: [LayersService, GeometryService, LayerSchemaService, WorkflowService],
  exports: [LayersService, GeometryService, LayerSchemaService],
})
export class LayersModule {}
