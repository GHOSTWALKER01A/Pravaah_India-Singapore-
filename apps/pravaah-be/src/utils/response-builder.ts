export interface PaginatedData<T> {
  items: T[]
  total: number
  page: number
  limit: number
  hasMore?: boolean
}

export class ResponseBuilder {
  static success<T>(
    data: T,
    message?: string,
  ): { success: boolean; timestamp: string; message: string; data: T } {
    return {
      success: true,
      timestamp: new Date().toISOString(),
      message: message || 'Success',
      data,
    }
  }

  static paginated<T>(
    items: T[],
    total: number,
    page: number,
    limit: number,
    message?: string,
  ): {
    success: boolean
    timestamp: string
    message: string
    data: PaginatedData<T>
  } {
    const hasMore = page * limit < total

    return {
      success: true,
      timestamp: new Date().toISOString(),
      message: message || 'Data fetched successfully',
      data: {
        items,
        total,
        page,
        limit,
        hasMore,
      },
    }
  }

  static paginatedWithOffset<T>(
    items: T[],
    total: number,
    offset: number,
    limit: number,
    message?: string,
  ): {
    success: boolean
    timestamp: string
    message: string
    data: PaginatedData<T>
  } {
    const page = Math.floor(offset / limit) + 1
    return this.paginated(items, total, page, limit, message)
  }
}
