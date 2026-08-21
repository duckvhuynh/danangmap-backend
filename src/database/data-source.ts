import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';

const isCompiled = __filename.endsWith('.js');

const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
  entities: [__dirname + `/../**/*.entit{y,ies}.${isCompiled ? 'js' : 'ts'}`],
  migrations: [__dirname + `/migrations/*.${isCompiled ? 'js' : 'ts'}`],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn', 'migration'] : ['error'],
});

export default AppDataSource;
