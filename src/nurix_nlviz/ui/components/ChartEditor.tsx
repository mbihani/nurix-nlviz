import { useState } from 'react';
import PlotlyEditor from 'react-chart-editor';
import 'react-chart-editor/lib/react-chart-editor.css';
import plotly from 'plotly.js/dist/plotly';

interface ChartEditorProps {
  figure: { data: any[]; layout: any };
  columns: Array<{ name: string; type?: string }>;
  rows: any[][];
  onUpdate: (figure: { data: any[]; layout: any }) => void;
  onClose: () => void;
}

export function ChartEditor({ figure, columns, rows, onUpdate, onClose }: ChartEditorProps) {
  const [editorData, setEditorData] = useState<any[]>(figure.data);
  const [editorLayout, setEditorLayout] = useState<any>(figure.layout);

  const dataSources: Record<string, any[]> = {};
  columns.forEach((col, i) => {
    dataSources[col.name] = rows.map((r) => r[i]);
  });
  const dataSourceOptions = columns.map((c) => ({ value: c.name, label: c.name }));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: '8px',
          width: '90vw',
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '16px' }}>Edit Chart</h3>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                onUpdate({ data: editorData, layout: editorLayout });
                onClose();
              }}
              style={{
                padding: '6px 16px',
                background: '#FF3621',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '6px 16px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                cursor: 'pointer',
                background: 'white',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <PlotlyEditor
            data={editorData}
            layout={editorLayout}
            config={{}}
            frames={[]}
            dataSources={dataSources}
            dataSourceOptions={dataSourceOptions}
            plotly={plotly}
            onUpdate={(data: any, layout: any) => {
              setEditorData(data);
              setEditorLayout(layout);
            }}
            useResizeHandler
            style={{ width: '100%', height: '100%' }}
            advancedTraceTypeSelector
          />
        </div>
      </div>
    </div>
  );
}
