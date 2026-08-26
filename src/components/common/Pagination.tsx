import { Pagination as MuiPagination, PaginationProps as MuiPaginationProps } from '@mui/material';

export interface PaginationProps extends MuiPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, onPageChange, ...props }: PaginationProps) {
  return (
    <MuiPagination
      count={totalPages}
      page={page}
      onChange={(_, value) => onPageChange(value)}
      color="primary"
      {...props}
    />
  );
}
