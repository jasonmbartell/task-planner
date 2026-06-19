import {
  format,
  parseISO,
  addDays as _addDays,
  differenceInDays,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  eachWeekOfInterval,
  isToday as _isToday,
  isSameMonth,
} from 'date-fns';

export const fmt = (date) => format(typeof date === 'string' ? parseISO(date) : date, 'yyyy-MM-dd');
export const fmtShort = (date) => format(typeof date === 'string' ? parseISO(date) : date, 'MMM d');
export const fmtFull = (date) => format(typeof date === 'string' ? parseISO(date) : date, 'EEEE, MMM d, yyyy');
export const addDays = (date, n) => fmt(_addDays(typeof date === 'string' ? parseISO(date) : date, n));
export const diffDays = (a, b) => differenceInDays(parseISO(b), parseISO(a));
export const isToday = (date) => _isToday(typeof date === 'string' ? parseISO(date) : date);

export const getMonday = (date) => {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return fmt(startOfWeek(d, { weekStartsOn: 1 }));
};

export const getWeekDays = (date) => {
  const d = typeof date === 'string' ? parseISO(date) : date;
  const start = startOfWeek(d, { weekStartsOn: 1 });
  const end = endOfWeek(d, { weekStartsOn: 1 });
  return eachDayOfInterval({ start, end }).map(fmt);
};

export const getMonthWeeks = (date) => {
  const d = typeof date === 'string' ? parseISO(date) : date;
  const monthStart = startOfMonth(d);
  const monthEnd = endOfMonth(d);
  const weeks = eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 });
  return weeks.map((weekStart) => {
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: weekStart, end: weekEnd }).map(fmt);
  });
};

export const isSameMonthAs = (dateA, dateB) => {
  const a = typeof dateA === 'string' ? parseISO(dateA) : dateA;
  const b = typeof dateB === 'string' ? parseISO(dateB) : dateB;
  return isSameMonth(a, b);
};

export const today = fmt(new Date());
