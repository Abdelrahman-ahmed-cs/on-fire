import React from 'react';

export default class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error(error);
  }
  render() {
    if (this.state.error)
      return (
        <div className="error" style={{ margin: 16 }}>
          {this.props.label ?? 'This part of the page'} failed to render: {String(this.state.error.message)}{' '}
          <button className="link" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    return this.props.children;
  }
}
