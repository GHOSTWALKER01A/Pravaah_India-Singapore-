import { API_ENDPOINTS } from '@/constants/api.constants';

import { BaseApiService } from '@/api/core/base-api-service';

import { CurrentUser } from './user.schema';

class UserService extends BaseApiService {
  constructor() {
    super(API_ENDPOINTS.USERS.BASE);
  }

  me(): Promise<CurrentUser> {
    return this.get<CurrentUser>(API_ENDPOINTS.USERS.ME);
  }
}

export const userService = new UserService();
