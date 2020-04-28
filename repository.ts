// IndexedDB + lokijs

import { DbAdapter } from '@app/services/dbAdapter/dbAdapter';
import { getNestedValue } from '@app/utils/commonHelpers';
import { addDays } from '@app/utils/dateHelper';
import { EqJoinOptions, SortTransformation } from '@app/interfaces';
import naturalCompare from 'string-natural-compare';
import uuidv4 from 'uuid/v4';

interface IWrite<T> {
  create(item: T): Promise<boolean>;
  insert(item: T): Promise<T | T[]>;
  save(item: T): Promise<T>;

  update(item): T | T[];
  delete(id: string): Promise<T | T[]>;
  clear(): void;
  removeWhere(where: (o) => boolean): void;
  remove(doc: object | number): void;
}

interface IRead<T> {
  find(condition, order?: {}): T[];
  findOne(id: string): T;
  count(condition): number;
  distinct(condition: any, distinctValues: string, order?: string): string[];
}

export class Repository<T extends object> implements IWrite<T>, IRead<T> {
  collection: Collection<T>;

  constructor(public entity: new () => T, public dbAdapter: DbAdapter, public collectionName: string) {
    this.collection = dbAdapter.initCollection(this.collectionName);
  }

  insert(data): Promise<T | T[]> {
    //
    return new Promise((resolve, reject) => {
      try {
        if (!data.hasOwnProperty('created')) {
          data.created = new Date().getUTCtime();
        }
        const result = this.collection.insert(data);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  async synchronize(entities: any[]) {
    for (const entity of entities) {
      const doc = this.findOne({ id: entity.id });
      if (doc) {
        entity['$loki'] = doc['$loki'];
        entity['meta'] = doc['meta'];
        this.update(entity);
      } else {
        await this.insert(entity);
      }
    }
  }

  save(data: any | any[]): Promise<T> {
    if (data instanceof Array) {
      data = data.map(item => {
        if (!item.id) {
          item.id = uuidv4();
        }
        item.updatedAt = new Date().getUTCtime();
        if (!item.hasOwnProperty('created')) {
          item.created = new Date().getUTCtime();
        }
        return item;
      });
    } else {
      if (!data.id) {
        data.id = uuidv4();
      }
      data.updatedAt = new Date().getUTCtime();
      if (!data.hasOwnProperty('created')) {
        data.created = new Date().getUTCtime();
      }
    }
    return new Promise((resolve, reject) => {
      try {
        let result;
        if (data instanceof Array && data.every(item => item.$loki)) {
          result = this.collection.update(data);
        } else if (data.$loki) {
          result = this.collection.update(data);
        } else {
          result = this.collection.insert(data);
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  create(item: T): Promise<boolean> {
    throw new Error('Method not implemented.');
  }

  update(item): T | T[] {
    return this.collection.update(item);
  }

  updateMany(conditionFind: {}, conditionUpdate: (obj: T) => void) {
    return this.collection
      .chain()
      .find(conditionFind)
      .update(conditionUpdate);
  }

  delete(id: string): Promise<T | T[]> {
    return new Promise((resolve, reject) => {
      const item = this.findOne({ id });
      Object.assign(item, { deleted: true });
      const result = this.collection.update(item);
      resolve(result);
    });
  }

  chain() {
    return this.collection.chain();
  }

  find(
    condition,
    order?: null | string | string[] | SortTransformation,
    limit?: number,
    offset?: number,
    eqJoin?: EqJoinOptions | EqJoinOptions[] | null
  ): T[] {
    let chain = this.collection.chain();

    if (eqJoin) {
      if (Array.isArray(eqJoin)) {
        eqJoin.forEach(ej => {
          chain.eqJoin(ej.joinData, ej.leftJoinKey, ej.rightJoinKey, ej.mapFun);
        });
      } else {
        chain.eqJoin(eqJoin.joinData, eqJoin.leftJoinKey, eqJoin.rightJoinKey, eqJoin.mapFun);
      }
    }

    if (typeof condition === 'object') {
      const { where } = condition;
      const conditionWithWhere = { ...condition };
      delete conditionWithWhere['where'];

      chain = chain.find(conditionWithWhere);
      if (where) {
        if (where instanceof Array) {
          where.forEach(whereCondition => {
            chain = chain.where(whereCondition);
          });
        } else {
          chain = chain.where(where);
        }
      }
    } else {
      chain = chain.where(condition);
    }

    if (order instanceof Array) {
      const orderArrayParams = [];
      order.map(value => {
        const { field: fieldValue, isDesc: descending } = this.parseOrder(value);
        orderArrayParams.push([fieldValue, descending]);
      });
      chain = chain.compoundsort(orderArrayParams);
    } else if (typeof order === 'object' && order) {
      chain = chain.sort(this.sortTransformation(order));
    } else if (order) {
      const { field, isDesc } = this.parseOrder(order);
      // TODO: Review this.sort
      if (field.includes('DEV')) {
        chain = chain.simplesort(field, isDesc);
      } else {
        const dateFields = [
          'dob',
          '-dob',
          'lastWeightDate',
          '-lastWeightDate',
          // Tasks
          'dueDate',
          '-dueDate'
        ];
        const weightFields = [
          'lastWeight',
          '-lastWeight',
          'lastAdgWeight',
          '-lastAdgWeight',
          'weight',
          '-weight',
          'weightAdg',
          '-weightAdg'
        ];
        if (dateFields.includes(field)) {
          chain = chain.sort(this.dateSort(field, isDesc));
        } else if (weightFields.includes(field)) {
          chain = chain.sort(this.numberSort(field, isDesc));
        } else {
          // chain = chain.sort((a, b) =>
          //   compare({ order: isDesc ? 'desc' : 'asc' })(a[field] || undefined, b[field] || undefined)
          // );
          chain = chain.sort(this.sort(field, isDesc));
        }
      }
    }
    if (limit) {
      chain = chain.limit(limit);
    }
    if (offset) {
      chain = chain.offset(offset);
    }
    return chain.data();
  }

  sort(field, isDesk) {
    return function(first, second) {
      let a = first[field];
      let b = second[field];

      a = parseFloat(a) || (a && a.toLowerCase()) || null;
      b = parseFloat(b) || (b && b.toLowerCase()) || null;

      if (!a || a === '0') {
        return 1;
      } else if (!b || b === '0') {
        return -1;
      } else if (a === b) {
        return 0;
      } else if (!isDesk) {
        return naturalCompare(a, b) > 0 ? 1 : -1;
      } else if (isDesk) {
        return naturalCompare(a, b) > 0 ? -1 : 1;
      }
    };
  }

  sortTransformation(order: SortTransformation) {
    return (a, b) => {
      a = order.transformation(a);
      b = order.transformation(b);

      if (order.type == 'number') {
        return this.numberSort(order.field, order.isDesc)(a, b);
      }
      return naturalCompare(a[order.field], b[order.field]);
    };
  }

  dateSort(field, isDesk) {
    let secondField = null;
    if (field.includes('+')) {
      [field, secondField] = field.split('+');
    }
    return function(first, second) {
      let a = getNestedValue(first, field);
      let b = getNestedValue(second, field);

      if (secondField) {
        a = addDays(a, first[secondField]);
        b = addDays(b, second[secondField]);
      }

      if (!a && a !== 0) {
        return 1;
      } else if (!b && b !== 0) {
        return -1;
      } else if (a === b) {
        return 0;
      } else if (!isDesk) {
        return a < b ? -1 : 1;
      } else if (isDesk) {
        return a < b ? 1 : -1;
      }
    };
  }

  numberSort(field, isDesk) {
    return function(first, second) {
      let a = first[field];
      let b = second[field];

      a = parseFloat(a) || a;
      b = parseFloat(b) || b;

      if (!a || a === '0') {
        return 1;
      } else if (!b || b === '0') {
        return -1;
      } else if (a === b) {
        return 0;
      } else if (!isDesk) {
        return a < b ? -1 : 1;
      } else if (isDesk) {
        return a < b ? 1 : -1;
      }
    };
  }

  findOne(condition): T | null {
    const item = this.collection.findOne(condition);
    if (item) {
      return { ...item };
    }
    return null;
  }

  clear() {
    this.collection.clear();
  }

  removeWhere(where) {
    return this.collection.removeWhere(where);
  }

  remove(doc) {
    return this.collection.remove(doc);
  }

  count(): number {
    return this.collection.count();
  }

  parseOrder(field) {
    let isDesc = false;
    if (field.indexOf('-') === 0) {
      field = field.substr(1);
      isDesc = true;
    }
    return { field, isDesc };
  }

  distinct(cond: any = {}, distinctProperty: string, order?: any): string[] {
    let chain = this.collection.chain();
    if (cond.where) {
      chain = chain.where(cond.where);
    }
    if (order) {
      const { field, isDesc } = this.parseOrder(order);
      chain = chain.simplesort(field, { desc: isDesc });
    }
    return chain.mapReduce(
      document => document[distinctProperty],
      documents => documents.filter((item, index, array) => array.indexOf(item) === index)
    );
  }
  applyFiltersToDynamicView(dynamicView, condition) {
    const { where, ...baseConditions } = condition;
    dynamicView.applyFind(baseConditions);
    dynamicView.applyWhere(where);
  }

  setDisableEmitEventsStatus(status: boolean) {
    return this.collection.setDisableEmitEventsStatus(status);
  }

  findAndUpdate(filterObject, updateFunction?) {
    return this.collection.findAndUpdate(filterObject, updateFunction);
  }
}
