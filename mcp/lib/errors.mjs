/** 仓库读写层共用错误类型 */
export class StoreError extends Error {
  constructor(message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
