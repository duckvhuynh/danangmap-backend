import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'danangmap.rawResponse';
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
