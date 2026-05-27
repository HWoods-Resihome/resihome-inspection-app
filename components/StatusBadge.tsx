interface Props {
  status: string;
}

// Map the HubSpot dropdown label to badge styling.
// Hayden's confirmed values: Scheduled, In Progress, Completed, Cancelled.
// We normalize to lowercase for matching to be defensive against case drift.
export function StatusBadge({ status }: Props) {
  const s = (status || '').trim().toLowerCase();

  let label = status || 'Unknown';
  let colorClass = 'bg-gray-100 text-gray-600 border-gray-300';

  if (s === 'scheduled') {
    colorClass = 'bg-gray-100 text-gray-700 border-gray-300';
    label = 'Scheduled';
  } else if (s === 'in progress' || s === 'in-progress' || s === 'inprogress') {
    colorClass = 'bg-amber-100 text-amber-800 border-amber-300';
    label = 'In Progress';
  } else if (s === 'completed' || s === 'complete' || s === 'submitted') {
    colorClass = 'bg-green-100 text-green-800 border-green-300';
    label = 'Completed';
  } else if (s === 'cancelled' || s === 'canceled') {
    colorClass = 'bg-gray-100 text-gray-500 border-gray-300 line-through';
    label = 'Cancelled';
  }

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-heading font-semibold border ${colorClass}`}
    >
      {label}
    </span>
  );
}
